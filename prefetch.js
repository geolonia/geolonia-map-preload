(function (global) {
  class TilePrefetcher {
    /**
     * @param {maplibregl.Map|geolonia.Map} map
     * @param {{
     *   neighbors?: number,
     *   zoomOutLevels?: number,
     *   debounceMs?: number,
     *   maxRequestsPerMove?: number,
     *   shouldPrefetch?: (url:string)=>boolean,
     *   debugFill?: boolean
     * }=} opts
     */
    constructor(map, opts = {}) {
      this.map = map;
      this.opts = Object.assign({
        neighbors: 1,
        zoomOutLevels: 1,
        debounceMs: 120,
        maxRequestsPerMove: 160,
        shouldPrefetch: (url) => /\.(pbf|mvt|png|jpg|jpeg)(\?|$)/.test(url),
        debugFill: true,
      }, opts);

      this._debounceTimer = null;
      this._inflight = new Set();
      this._tilejsonCache = new Map(); // sourceId -> {tiles:[]}
      this._templates = [];            // 解決済み tile URL templates
      this._onMoveEnd = this._onMoveEnd.bind(this);

      // styledata 再入防止フラグ
      this._styledataGuard = false;

      if (map.isStyleLoaded && map.isStyleLoaded()) this._bind();
      else map.on("load", () => this._bind());
    }

    destroy() {
      this.map.off("moveend", this._onMoveEnd);
      this.map.off("styledata", this._onStyleDataBound);
      this._inflight.clear();
      this._tilejsonCache.clear();
      this._templates = [];
    }

    // 公開API: 塗りON/OFF
    setFillEnabled(enabled) {
      this.opts.debugFill = !!enabled;
      this._applyFillVisibility();
    }

    // ---- 内部 ----
    _bind() {
      this._ensureDebugLayers();
      // styledata を安全に処理
      this._onStyleDataBound = this._onStyleData.bind(this);
      this.map.on("styledata", this._onStyleDataBound);
      this.map.on("moveend", this._onMoveEnd);
      this._resolveTemplates().then(() => this._onMoveEnd());
    }

    _onStyleData() {
      if (this._styledataGuard) return;
      this._styledataGuard = true;
      try {
        this._ensureDebugLayers(); // レイヤ存在確保（並べ替えは必要時のみ）
        this._resolveTemplates();  // タイルテンプレ更新
      } finally {
        requestAnimationFrame(() => { this._styledataGuard = false; });
      }
    }

    _onMoveEnd() {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this._prefetchNow(), this.opts.debounceMs);
    }

    async _resolveTemplates() {
      const style = this.map.getStyle?.();
      if (!style || !style.sources) return;

      const templates = [];
      for (const [id, src] of Object.entries(style.sources)) {
        if (Array.isArray(src.tiles) && src.tiles.length) {
          templates.push(...src.tiles);
          continue;
        }
        if (src.url && typeof src.url === 'string') {
          const cached = this._tilejsonCache.get(id);
          if (cached) {
            if (Array.isArray(cached.tiles)) templates.push(...cached.tiles);
            continue;
          }
          try {
            const tj = await this._fetchTileJSON(src.url);
            const t = Array.isArray(tj.tiles) ? tj.tiles : [];
            this._tilejsonCache.set(id, { tiles: t });
            templates.push(...t);
          } catch (e) {
            console.warn(`[prefetch] TileJSON取得失敗: ${id}`, e);
          }
        }
      }
      this._templates = templates.filter(u => typeof u === 'string');

      if (!this._lastLog || this._lastLog !== this._templates.length) {
        console.debug(`[prefetch] templates resolved: ${this._templates.length}`);
        this._lastLog = this._templates.length;
      }
    }

    async _fetchTileJSON(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }

    async _prefetchNow() {
      if (!this._templates.length) {
        await this._resolveTemplates();
        if (!this._templates.length) return;
      }
      const z = Math.max(0, Math.min(22, Math.floor(this.map.getZoom())));
      const b = this.map.getBounds();
      const { minX, maxX, minY, maxY, tilesAtZ } = this._visibleTileRange(b, z);

      const urls = new Set();
      const neighborSet = new Set(); // "z/x/y"
      const parentSet = new Set();   // "z/x/y"

      // 同ズーム：neighbors
      if (this.opts.neighbors > 0) {
        const tiles = this._collectNeighborsTiles(z, minX, minY, maxX, maxY, this.opts.neighbors);
        for (const {x,y} of tiles) {
          neighborSet.add(`${z}/${x}/${y}`);
          for (const tmpl of this._templates) {
            const u = this._tileURL(tmpl, z, x, y); if (u) urls.add(u);
          }
        }
      }

      // 親ズーム：zoomOutLevels
      const levels = Math.max(0, this.opts.zoomOutLevels | 0);
      for (let d = 1; d <= levels; d++) {
        const pz = z - d; if (pz < 0) break;
        const tmp = new Set();
        for (const {x,y} of tilesAtZ) {
          let px = x, py = y;
          for (let k=0;k<d;k++){ px = Math.floor(px/2); py = Math.floor(py/2); }
          tmp.add(`${pz}/${px}/${py}`);
        }
        for (const key of tmp) {
          parentSet.add(key);
          const [pzStr, pxStr, pyStr] = key.split('/');
          for (const tmpl of this._templates) {
            const u = this._tileURL(tmpl, +pzStr, +pxStr, +pyStr); if (u) urls.add(u);
          }
        }
      }

      // デバッグ表示（※ここでは並べ替えしない）
      this._updateDebugOverlay(neighborSet, parentSet);

      // Console
      console.log("%cNeighbors (blue):", "color:blue;font-weight:bold", [...neighborSet]);
      console.log("%cParents (red):", "color:red;font-weight:bold", [...parentSet]);

      // Prefetch
      const list = [...urls].filter(this.opts.shouldPrefetch).slice(0, this.opts.maxRequestsPerMove);
      for (const u of list) {
        if (this._inflight.has(u)) continue;
        this._inflight.add(u);
        fetch(u).catch(()=>{}).finally(()=>this._inflight.delete(u));
      }
    }

    _collectNeighborsTiles(z, minX, minY, maxX, maxY, n) {
      const t = 2 ** z, wrapX = (x)=>((x%t)+t)%t, clampY=(y)=>Math.max(0,Math.min(t-1,y));
      const out = [];
      for (let x=minX-n; x<=maxX+n; x++) {
        for (let y=minY-n; y<=maxY+n; y++) {
          const inside = x>=minX && x<=maxX && y>=minY && y<=maxY;
          if (inside) continue;
          out.push({ x: wrapX(x), y: clampY(y) });
        }
      }
      return out;
    }

    _visibleTileRange(bounds, z) {
      const vxMinX = Math.floor(this._lon2tile(bounds.getWest(), z));
      const vxMaxX = Math.floor(this._lon2tile(bounds.getEast(), z));
      const vyMinY = Math.floor(this._lat2tile(bounds.getNorth(), z));
      const vyMaxY = Math.floor(this._lat2tile(bounds.getSouth(), z));
      const t = 2 ** z, wrapX=(x)=>((x%t)+t)%t, clampY=(y)=>Math.max(0,Math.min(t-1,y))**
