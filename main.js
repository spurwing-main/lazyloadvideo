/*
  video-lazy.autoboot.js v1.0.0
  MIT License

  Drop-in, attribute-driven, video-only lazy loader for modern sites.
  Include once in <head> (with or without defer); no page JS required.

  ——— Why this exists ———
  • Faster first render: prevents eager video fetching until needed.
  • Pure HTML control via data-vl-* attributes.
  • Safe autoplay: muted + playsinline where appropriate.
  • Robust on dynamic pages: MutationObserver attaches/detaches as DOM changes.
  • Built-in debug logging via <script data-vl-debug> and per-element data-vl-debug.

  Usage (HTML):
    <script src="/path/video-lazy.autoboot.js" data-vl-debug></script>
    <video
      data-vl
      data-vl-src="/media/clip.mp4"           
      data-vl-play="visible hover"            
      data-vl-parent=".card"                  
      data-vl-margin="300px 0px"              
      data-vl-threshold="0"                   
      data-vl-preload="metadata"              
      data-vl-mute="true"                     
      data-vl-pause-hidden="true"             
      data-vl-resume="true"                   
      data-vl-pause-page-hidden="false"       
      loop muted controls playsinline>
      <source data-vl-src="/media/clip-720.mp4" type="video/mp4">
      <source data-vl-src="/media/clip-720.webm" type="video/webm">
    </video>
*/

;(function(){
    'use strict';
  
    // ==========================================================================
    // Constants & attribute names
    // ==========================================================================
  
    var ATTR = {
      ROOT: 'data-vl',
      SRC: 'data-vl-src',
      PLAY: 'data-vl-play', // list: load|visible|hover|parent-hover (space/comma separated)
      PARENT: 'data-vl-parent',
      MARGIN: 'data-vl-margin',
      THRESHOLD: 'data-vl-threshold',
      PRELOAD: 'data-vl-preload', // none|metadata|auto (applied when loading begins)
      MUTE: 'data-vl-mute', // true|false
      PAUSE_HIDDEN: 'data-vl-pause-hidden', // true|false
      RESUME: 'data-vl-resume', // true|false
      PAUSE_PAGE: 'data-vl-pause-page-hidden', // true|false
      DEBUG: 'data-vl-debug' // per-element debug
    };
  
    var IO_SUPPORTED = typeof window !== 'undefined' && 'IntersectionObserver' in window;
    var DOC = typeof document !== 'undefined' ? document : null;
    var WIN = typeof window !== 'undefined' ? window : {};
  
    // Maintain one instance per <video>
    var REGISTRY = new WeakMap();
  
    // ==========================================================================
    // Debug logger (script-level + element-level)
    // ==========================================================================
  
    var GLOBAL_DEBUG = (function(){
      if (!DOC) return !!WIN.VIDEO_LAZY_DEBUG;
      try {
        var s = DOC.currentScript;
        if (!s){ var arr = DOC.getElementsByTagName('script'); s = arr[arr.length-1]; }
        if (!s) return !!WIN.VIDEO_LAZY_DEBUG;
        var val = s.getAttribute(ATTR.DEBUG);
        if (val == null) return !!WIN.VIDEO_LAZY_DEBUG;
        return (val === '' || String(val).toLowerCase() === 'true');
      } catch(e){ return !!WIN.VIDEO_LAZY_DEBUG; }
    })();
  
    function shouldDebug(el){
      if (!el || !el.getAttribute) return GLOBAL_DEBUG;
      var val = el.getAttribute(ATTR.DEBUG);
      if (val == null) return GLOBAL_DEBUG;
      if (val === '') return true;
      return String(val).toLowerCase() === 'true';
    }
    function log(el){ if (!shouldDebug(el)) return; var a = Array.prototype.slice.call(arguments,1); a.unshift('[VideoLazy]'); try{ console.log.apply(console,a);}catch(e){} }
    function warn(el){ if (!shouldDebug(el)) return; var a = Array.prototype.slice.call(arguments,1); a.unshift('[VideoLazy] ⚠'); try{ console.warn.apply(console,a);}catch(e){} }
  
    // ==========================================================================
    // Utilities (small, pure, readable)
    // ==========================================================================
  
    function isVideo(el){ return el instanceof HTMLVideoElement; }
  
    function readBool(el, name, fallback){
      var v = el.getAttribute(name);
      if (v == null) return fallback;
      if (v === '') return true; // presence => true
      return String(v).toLowerCase() === 'true';
    }
  
    function readNum(el, name, fallback){
      var v = el.getAttribute(name);
      if (v == null || v === '') return fallback;
      var n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    }
  
    function readList(el, name){
      var v = el.getAttribute(name) || '';
      var parts = v.split(/[\s,]+/);
      var out = {};
      for (var i=0;i<parts.length;i++){ if (parts[i]) out[parts[i]] = true; }
      return out; // object lookup instead of Set (perf + compat)
    }
  
    function closestOrParent(el, selector){ return selector ? el.closest(selector) : (el.parentElement || null); }
  
    function once(target, type, fn){
      function h(e){ try { fn(e); } finally { target.removeEventListener(type, h); } }
      target.addEventListener(type, h);
    }
  
    function hasNativeSources(video){
      if (!isVideo(video)) return false;
      if (video.currentSrc) return true; // selected source exists
      if (video.src) return true;
      var children = video.querySelectorAll('source');
      for (var i=0;i<children.length;i++){
        if (children[i].getAttribute('src')) return true;
      }
      return false;
    }
  
    function applySources(video){
      // Prefer <source data-vl-src> children; fallback to data-vl-src on <video>
      var selector = 'source[' + ATTR.SRC + ']';
      var sources = video.querySelectorAll(selector);
      if (sources.length){
        for (var i=0;i<sources.length;i++){
          var s = sources[i];
          s.setAttribute('src', s.getAttribute(ATTR.SRC));
          s.removeAttribute(ATTR.SRC);
        }
      } else {
        var src = video.getAttribute(ATTR.SRC);
        if (src){ video.src = src; video.removeAttribute(ATTR.SRC); }
      }
      var desiredPreload = video.getAttribute(ATTR.PRELOAD) || 'none';
      video.preload = desiredPreload; // none|metadata|auto
      video.load();
    }
  
    function tryPlay(video){ try { var p = video.play(); if (p && typeof p.then === 'function') p.catch(function(){}); } catch(e){} }
    function tryPause(video){ try { video.pause(); } catch(e){} }
  
    function inViewport(el){
      if (!el || !el.getBoundingClientRect) return false;
      var r = el.getBoundingClientRect();
      var iw = WIN.innerWidth || DOC.documentElement.clientWidth;
      var ih = WIN.innerHeight || DOC.documentElement.clientHeight;
      return r.bottom > 0 && r.right > 0 && r.left < iw && r.top < ih;
    }
  
    // ==========================================================================
    // Instance class (one per <video>)
    // ==========================================================================
  
    function Instance(el){
      if (!isVideo(el)) throw new TypeError('VideoLazy: attach expects a <video>');
      this.el = el;
      this.observer = null;
      this.cleanups = [];
      this.loaded = hasNativeSources(el); // treat as already loaded if native src exists
      this.config = this._readConfig();
      this._init();
      log(el, 'attached', this.config);
    }
  
    Instance.prototype._readConfig = function(){
      var v = this.el;
      var plays = readList(v, ATTR.PLAY); // load|visible|hover|parent-hover
      return {
        lazy: (v.hasAttribute(ATTR.ROOT) && v.getAttribute(ATTR.ROOT) !== 'eager'),
        margin: v.getAttribute(ATTR.MARGIN) || '300px 0px',
        threshold: readNum(v, ATTR.THRESHOLD, 0),
        parentSelector: v.getAttribute(ATTR.PARENT) || null,
        pauseOnHidden: readBool(v, ATTR.PAUSE_HIDDEN, true),
        resumeOnReenter: readBool(v, ATTR.RESUME, true),
        pauseOnPageHidden: readBool(v, ATTR.PAUSE_PAGE, false),
        play: {
          onLoad: !!plays['load'],
          onVisible: !!(plays['visible'] || plays['view']),
          onHover: !!plays['hover'],
          onParentHover: !!plays['parent-hover']
        },
        autoMute: readBool(
          v,
          ATTR.MUTE,
          !!(plays['load'] || plays['visible'] || plays['view'] || plays['hover'] || plays['parent-hover'])
        )
      };
    };
  
    Instance.prototype._init = function(){
      var v = this.el; var c = this.config; var self = this;
  
      // Keep network quiet until we decide to load (only for managed-lazy & no native sources)
      if (!this.loaded && c.lazy) v.preload = 'none';
  
      // Hover / parent-hover
      this._bindHover();
  
      // Page visibility pause (optional) + resume when visible & in viewport
      if (c.pauseOnPageHidden){
        var onVis = function(){
          if (DOC.hidden) { tryPause(v); }
          else if (c.play.onVisible && c.resumeOnReenter && inViewport(v)) { self._autoplay(); }
        };
        DOC.addEventListener('visibilitychange', onVis);
        this.cleanups.push(function(){ DOC.removeEventListener('visibilitychange', onVis); });
      }
  
      // IntersectionObserver path
      if (c.lazy && IO_SUPPORTED){
        this.observer = new IntersectionObserver(function(entries){ self._onIntersect(entries); }, {
          root: null,
          rootMargin: c.margin,
          threshold: c.threshold
        });
        this.observer.observe(v);
        if (c.play.onLoad) once(v, 'loadeddata', function(){ self._autoplay(); });
      } else {
        // Eager path (no IO or explicitly eager)
        this._ensureLoaded();
        if (c.play.onLoad) once(v, 'loadeddata', function(){ self._autoplay(); });
        if (c.play.onVisible && !IO_SUPPORTED) this._autoplay();
      }
    };
  
    Instance.prototype._bindHover = function(){
      var v = this.el; var c = this.config; var self = this;
  
      if (c.play.onHover){
        var enterV = function(){ self._ensureLoaded(); self._autoplay(); };
        var leaveV = function(){ tryPause(v); };
        v.addEventListener('mouseenter', enterV);
        v.addEventListener('mouseleave', leaveV);
        this.cleanups.push(function(){ v.removeEventListener('mouseenter', enterV); v.removeEventListener('mouseleave', leaveV); });
      }
  
      if (c.play.onParentHover){
        var parent = closestOrParent(v, c.parentSelector);
        if (parent){
          var enterP = function(){ self._ensureLoaded(); self._autoplay(); };
          var leaveP = function(){ tryPause(v); };
          parent.addEventListener('mouseenter', enterP);
          parent.addEventListener('mouseleave', leaveP);
          this.cleanups.push(function(){ parent.removeEventListener('mouseenter', enterP); parent.removeEventListener('mouseleave', leaveP); });
        } else {
          warn(v, 'parent-hover specified but parent not found for selector:', c.parentSelector);
        }
      }
    };
  
    Instance.prototype._ensureLoaded = function(){
      if (this.loaded) return;
      // Guard: if no data-vl-src anywhere, warn once
      var hasDataSrc = this.el.hasAttribute(ATTR.SRC) || this.el.querySelector('source[' + ATTR.SRC + ']');
      if (!hasDataSrc) warn(this.el, 'no data-vl-src found on <video> or <source>; nothing to lazy-load');
      applySources(this.el);
      this.loaded = true;
      log(this.el, 'sources applied');
    };
  
    Instance.prototype._autoplay = function(){
      var v = this.el; var c = this.config;
      if (c.autoMute) v.muted = true; // autoplay policy friendly
      if (!v.hasAttribute('playsinline')) v.setAttribute('playsinline', '');
      tryPlay(v);
      log(v, 'autoplay attempted');
    };
  
    Instance.prototype._onIntersect = function(entries){
      var v = this.el; var c = this.config;
      for (var i=0;i<entries.length;i++){
        var entry = entries[i];
        if (entry.target !== v) continue;
        if (entry.isIntersecting || entry.intersectionRatio > 0){
          if (!this.loaded){ this._ensureLoaded(); if (c.play.onVisible) this._autoplay(); }
          else if (c.play.onVisible && c.resumeOnReenter){ this._autoplay(); }
          // Keep observing only if needed for future behavior
          var needsIO = c.play.onVisible || c.pauseOnHidden || c.resumeOnReenter;
          if (!needsIO && this.observer){ this.observer.unobserve(v); this.observer.disconnect(); this.observer = null; }
        } else {
          if (c.pauseOnHidden) tryPause(v);
        }
      }
    };
  
    Instance.prototype.refresh = function(){
      // re-read attributes, re-bind behaviors. Preserve loaded state unless SRC changed.
      var wasLoaded = this.loaded;
      this.destroy();
      this.loaded = wasLoaded || hasNativeSources(this.el);
      this.config = this._readConfig();
      this._init();
      log(this.el, 'refreshed');
    };
  
    Instance.prototype.reloadSources = function(){
      // Force re-apply sources (used when data-vl-src changed after load)
      applySources(this.el);
      this.loaded = true;
      log(this.el, 'sources reloaded');
    };
  
    Instance.prototype.destroy = function(){
      if (this.observer){ try { this.observer.unobserve(this.el); this.observer.disconnect(); } catch(e){} this.observer = null; }
      for (var i=0;i<this.cleanups.length;i++){ try { this.cleanups[i](); } catch(e){} }
      this.cleanups.length = 0;
      log(this.el, 'destroyed');
    };
  
    // ==========================================================================
    // Public API (also used by autoboot)
    // ==========================================================================
  
    var API = {
      attach: function(el){
        if (!isVideo(el)) return null;
        var prev = REGISTRY.get(el);
        if (prev){ prev.destroy(); }
        var inst = new Instance(el);
        REGISTRY.set(el, inst);
        return inst;
      },
      detach: function(el){
        var inst = REGISTRY.get(el);
        if (inst){ inst.destroy(); REGISTRY.delete(el); }
      },
      refresh: function(el){ var inst = REGISTRY.get(el); if (inst) inst.refresh(); },
      reloadSources: function(el){ var inst = REGISTRY.get(el); if (inst) inst.reloadSources(); },
      attachAll: function(root){
        root = root || DOC; if (!root) return [];
        var nodes = root.querySelectorAll('video[' + ATTR.ROOT + ']');
        var out = []; for (var i=0;i<nodes.length;i++){ out.push(API.attach(nodes[i])); }
        return out;
      },
      play: function(el){ if (isVideo(el)) tryPlay(el); },
      pause: function(el){ if (isVideo(el)) tryPause(el); },
      _onAttr: function(el, name){
        var inst = REGISTRY.get(el);
        if (!inst){ if (name === ATTR.ROOT && el.hasAttribute(ATTR.ROOT)) API.attach(el); return; }
        if (name === ATTR.SRC){
          // If src attributes changed after load, re-apply new sources immediately
          inst.reloadSources();
        } else {
          inst.refresh();
        }
      }
    };
  
    // Expose for debugging/imperative usage (but not required for auto-init)
    if (typeof window !== 'undefined') window.VideoLazy = API;
  
    // ==========================================================================
    // Autoboot: DOM ready + MutationObserver for dynamic pages
    // ==========================================================================
  
    var ATTR_FILTER = [
      ATTR.ROOT, ATTR.SRC, ATTR.PARENT, ATTR.PLAY, ATTR.MARGIN, ATTR.THRESHOLD,
      ATTR.PRELOAD, ATTR.MUTE, ATTR.PAUSE_HIDDEN, ATTR.RESUME, ATTR.PAUSE_PAGE, ATTR.DEBUG
    ];
  
    function boot(){
      API.attachAll(DOC);
  
      // Observe dynamic DOM changes
      var mo = new MutationObserver(function(mutations){
        for (var x=0;x<mutations.length;x++){
          var m = mutations[x];
          // Handle added nodes (and their descendants)
          if (m.type === 'childList'){
            if (m.addedNodes){
              for (var i=0;i<m.addedNodes.length;i++){
                var node = m.addedNodes[i];
                if (node.nodeType !== 1) continue;
                if (isVideo(node) && node.hasAttribute(ATTR.ROOT)){
                  API.attach(node);
                } else if (node.querySelectorAll){
                  var vids = node.querySelectorAll('video[' + ATTR.ROOT + ']');
                  for (var j=0;j<vids.length;j++){ API.attach(vids[j]); }
                }
              }
            }
            // Clean up removed nodes
            if (m.removedNodes){
              for (var r=0;r<m.removedNodes.length;r++){
                var rnode = m.removedNodes[r];
                if (rnode.nodeType !== 1) continue;
                if (isVideo(rnode)) API.detach(rnode);
                else if (rnode.querySelectorAll){
                  var rv = rnode.querySelectorAll('video');
                  for (var k=0;k<rv.length;k++){ API.detach(rv[k]); }
                }
              }
            }
          }
  
          // Handle attribute changes on managed elements
          if (m.type === 'attributes' && isVideo(m.target) && ATTR_FILTER.indexOf(m.attributeName) !== -1){
            API._onAttr(m.target, m.attributeName);
          }
        }
      });
  
      mo.observe(DOC.documentElement || DOC.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ATTR_FILTER
      });
    }
  
    if (!DOC) return; // non-browser safety
    if (DOC.readyState === 'complete' || DOC.readyState === 'interactive'){
      // If included late or with defer, run now
      boot();
    } else {
      // If included early in <head>, wait for DOM
      DOC.addEventListener('DOMContentLoaded', boot);
    }
  })();