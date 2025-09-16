// tile-prefetcher.js
// UMD風: <script src="tile-prefetcher.js"></script> で window.TilePrefetcher を提供
(function (global) {
  class TilePrefetcher {
    /**
     * @param {maplibregl.Map|geolonia.Map} map
     * @param {{
     *   sourceIds?: string[],
     *   neighbors?: number,          // 同ズームの外側リング数 (0=なし)
     *   zoomOutLevels?: number,      // 親ズーム段数 (0=なし)
     *   debounceMs?: number,
     *   maxRequestsPerMove?: number,
     *   requestInit?: RequestInit,
     *   shouldPrefetch?: (url:string)=>boolean,
     *   debugFill?: boolean          // 塗りの可視化を行うか（true=塗る、false=枠線のみ）
     * }=} opts
     */
    constructor(map, opts = {}) {
      this.map = map;
      this.opts = Object.assign({
        neighbors: 1,
        zoomOutLevels: 1,
        debounceMs: 120,
        maxRequestsPerMove: 160,
        requestInit: undefined,
        shouldPrefetch: (url) => /\.(pbf|mvt|png|jpg|jpeg)(\?|$)/.test(url),
        sourceIds: undefined,
        debugFill: true,
      }, opts);

      this._debounceTimer = null;
      this._inflight = new Set();
      this._tilejsonCache = new Map(); // sourceId -> {tiles:[]}
      this._templates = [];            // 展開済み tile URL templates
      this._onMoveEnd = this._onMoveEnd.bind(this);

      if (map.isStyleLoaded && map.isStyleLoaded()) this._bind();
      else map.on("load", () => this._bind());
    }

    destroy() {
      this.map.off("moveend", this._onMoveEnd);
      this._inflight.clear();
      this._tilejsonCache.clear();
      this._templates = [];
      // デバッグレイヤは残す（必要ならここでremoveも可）
    }

    // ---- Public: 塗りON/OFF ----
    setFillEnabled(enabled) {
      this.opts.debugFill = !!enabled;
      this._applyFillVisibility();
    }

    // ---- 内部 ----
    _bind() {
      this._ensureDebugLayers();
      this.map.on("styledata", () => {
        this._ensureDebugLayers(); // スタイル再読込時にレイヤ再生成
        this._resolveTemplates();
      });
      this.map.on("moveend", this._onMoveEnd);
      this._resolveTemplates().then(() => this._onMoveEnd());
    }

    _onMoveEnd() {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this._prefetchNow(), this.opts.debounceMs);
    }

    async _resolveTemplates() {
      const style = this.map.getStyle?.();
      if (!style || !style.sources) return;
      const wanted = this.opts.sourceIds?.length ? new Set(this.opts.sourceIds) : null;

      const templates = [];
      for (const [id, src] of Object.entries(style.sources)) {
        if (wanted && !wanted.has(id)) continue;

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
      console.debug(`[prefetch] templates resolved: ${this._templates.length}`);
    }

    async _fetchTileJSON(url) {
      const res = await fetch(url, this.opts.requestInit);
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

      // デバッグ可視化
      this._updateDebugOverlay(neighborSet, parentSet);

      // Console も出す
      console.log("%cNeighbors (blue):", "color:blue;font-weight:bold", [...neighborSet]);
      console.log("%cParents (red):", "color:red;font-weight:bold", [...parentSet]);

      // Prefetch
      const list = [...urls].filter(this.opts.shouldPrefetch).slice(0, this.opts.maxRequestsPerMove);
      for (const u of list) {
        if (this._inflight.has(u)) continue;
        this._inflight.add(u);
        fetch(u, this.opts.requestInit).catch(()=>{}).finally(()=>this._inflight.delete(u));
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
      const t = 2 ** z, wrapX=(x)=>((x%t)+t)%t, clampY=(y)=>Math.max(0,Math.min(t-1,y));
      const tilesAtZ = [];
      for (let x=vxMinX; x<=vxMaxX; x++) for (let y=vyMinY; y<=vyMaxY; y++) tilesAtZ.push({x:wrapX(x), y:clampY(y), z});
      return { minX:vxMinX, maxX:vxMaxX, minY:vyMinY, maxY:vyMaxY, tilesAtZ };
    }

    _tileURL(tmpl, z, x, y) {
      if (!tmpl.includes('{z}') || !tmpl.includes('{x}') || !tmpl.includes('{y}')) return null;
      return tmpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    }
    _lon2tile(lon,z){ return ((lon+180)/360)*2**z; }
    _lat2tile(lat,z){ const r=lat*Math.PI/180; return ((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2)*2**z; }
    _tile2lon(x,z){ return x/2**z*360-180; }
    _tile2lat(y,z){ const n=Math.PI-2*Math.PI*y/2**z; return 180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n))); }

    _tilePolygonFeature(z,x,y){
      const w=this._tile2lon(x,z), e=this._tile2lon(x+1,z), n=this._tile2lat(y,z), s=this._tile2lat(y+1,z);
      return { type:"Feature", properties:{z,x,y}, geometry:{ type:"Polygon", coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]} };
    }

    _ensureDebugLayers(){
      const m=this.map;

      // sources
      if (!m.getSource('prefetch-neighbors')) m.addSource('prefetch-neighbors',{ type:'geojson', data:{ type:'FeatureCollection', features:[] }});
      if (!m.getSource('prefetch-parents'))  m.addSource('prefetch-parents',{  type:'geojson', data:{ type:'FeatureCollection', features:[] }});

      // fill layers（可視/不可視は後で制御）
      if (!m.getLayer('prefetch-neighbors-fill')) {
        m.addLayer({ id:'prefetch-neighbors-fill', type:'fill', source:'prefetch-neighbors',
          paint:{ 'fill-color':'#1e90ff','fill-opacity':0.18 } });
      }
      if (!m.getLayer('prefetch-parents-fill')) {
        m.addLayer({ id:'prefetch-parents-fill', type:'fill', source:'prefetch-parents',
          paint:{ 'fill-color':'#ff3b30','fill-opacity':0.18 } });
      }

      // line layers（常に表示）
      if (!m.getLayer('prefetch-neighbors-line')) {
        m.addLayer({ id:'prefetch-neighbors-line', type:'line', source:'prefetch-neighbors',
          paint:{ 'line-color':'#1e90ff','line-width':2,'line-opacity':0.9 } });
      }
      if (!m.getLayer('prefetch-parents-line')) {
        m.addLayer({ id:'prefetch-parents-line', type:'line', source:'prefetch-parents',
          paint:{ 'line-color':'#ff3b30','line-width':2,'line-opacity':0.9 } });
      }

      // 塗りの可視状態を反映
      this._applyFillVisibility();

      // 最前面へ
      const toTop = (id) => { const L=m.getStyle().layers||[]; const last=L[L.length-1]?.id; if (last && last!==id) m.moveLayer(id,last); };
      ['prefetch-neighbors-fill','prefetch-neighbors-line','prefetch-parents-fill','prefetch-parents-line'].forEach(toTop);
    }

    _applyFillVisibility(){
      const m=this.map;
      const vis = this.opts.debugFill ? 'visible' : 'none';
      if (m.getLayer('prefetch-neighbors-fill')) m.setLayoutProperty('prefetch-neighbors-fill', 'visibility', vis);
      if (m.getLayer('prefetch-parents-fill'))  m.setLayoutProperty('prefetch-parents-fill',  'visibility', vis);
    }

    _updateDebugOverlay(neighborSet, parentSet){
      const nf=[], pf=[];
      for (const k of neighborSet){ const [z,x,y]=k.split('/').map(Number); nf.push(this._tilePolygonFeature(z,x,y)); }
      for (const k of parentSet){ const [z,x,y]=k.split('/').map(Number);  pf.push(this._tilePolygonFeature(z,x,y)); }
      this.map.getSource('prefetch-neighbors')?.setData({ type:'FeatureCollection', features:nf });
      this.map.getSource('prefetch-parents')?.setData({ type:'FeatureCollection', features:pf });

      // 最前面維持
      const toTop = (id) => { const L=this.map.getStyle().layers||[]; const last=L[L.length-1]?.id; if (last && last!==id) this.map.moveLayer(id,last); };
      ['prefetch-neighbors-fill','prefetch-neighbors-line','prefetch-parents-fill','prefetch-parents-line'].forEach(toTop);
    }
  }

  // export
  global.TilePrefetcher = TilePrefetcher;
})(typeof window !== 'undefined' ? window : globalThis);
