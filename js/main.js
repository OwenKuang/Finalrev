// finalREV redesign — page wiring: nav, theme, quote buttons, hero video, videos rail, simulator.
import { initUpload, openQuote } from './upload.js?v=6';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- toast
const toastEl = $('#toast');
let toastTimer = 0;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 6000);
}

// ---------------------------------------------------------------- nav
const menuBtn = $('#menu-btn');
const menu = $('#mobile-menu');
menuBtn.addEventListener('click', () => {
  const open = menuBtn.getAttribute('aria-expanded') !== 'true';
  menuBtn.setAttribute('aria-expanded', open);
  menu.hidden = !open;
});
menu.addEventListener('click', (e) => {
  if (e.target.closest('a')) { menuBtn.setAttribute('aria-expanded', 'false'); menu.hidden = true; }
});

// ---------------------------------------------------------------- light / dark theme
{
  const root = document.documentElement;
  const btn = $('#theme-btn');
  const meta = $('meta[name="theme-color"]');
  const sysLight = matchMedia('(prefers-color-scheme: light)');
  const stored = () => { try { return localStorage.getItem('theme'); } catch { return null; } };
  function set(theme, save) {
    root.dataset.theme = theme;
    meta.content = theme === 'light' ? '#f2f4ef' : '#101210';
    btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
    if (save) { try { localStorage.setItem('theme', theme); } catch {} }
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
  }
  // an animated switch wipes the new theme over the old one: top-down into light, bottom-up into dark
  let wipes = 0;
  function apply(theme, { save = false, animate = false } = {}) {
    if (!animate || reduceMotion) return set(theme, save);
    if (document.startViewTransition) {
      const id = ++wipes;
      root.dataset.wipe = theme === 'light' ? 'down' : 'up';
      document.startViewTransition(() => set(theme, save)).finished.finally(() => { if (id === wipes) delete root.dataset.wipe; });
      return;
    }
    root.classList.add('theme-fade');
    setTimeout(() => root.classList.remove('theme-fade'), 350);
    set(theme, save);
  }
  apply(root.dataset.theme === 'light' ? 'light' : 'dark');
  btn.addEventListener('click', () => apply(root.dataset.theme === 'light' ? 'dark' : 'light', { save: true, animate: true }));
  // follow the OS setting until the visitor picks one
  sysLight.addEventListener('change', (e) => { if (!stored()) apply(e.matches ? 'light' : 'dark', { animate: true }); });
}

// ---------------------------------------------------------------- nav: sliding carriage under the links
{
  const nav = $('#nav');
  const links = $('#nav-links');
  const car = $('#nav-carriage');
  const items = $$('a', links);
  const home = items.find((a) => a.hasAttribute('aria-current')) || items[0];
  const moveTo = (a) => {
    const lr = links.getBoundingClientRect(), r = a.getBoundingClientRect();
    car.style.width = `${Math.max(16, r.width - 36)}px`;
    car.style.transform = `translateX(${r.left - lr.left + 18}px)`;
  };
  items.forEach((a) => { a.addEventListener('mouseenter', () => moveTo(a)); a.addEventListener('focus', () => moveTo(a)); });
  links.addEventListener('mouseleave', () => moveTo(home));
  links.addEventListener('focusout', () => moveTo(home));
  new ResizeObserver(() => moveTo(home)).observe(links);
  document.fonts?.ready.then(() => moveTo(home));
  const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

// ---------------------------------------------------------------- hero entrance + variant A text scaling
{
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: 0.25 });
  $$('.hero').forEach((h) => io.observe(h));
  // Variant A's text is an 800px design block scaled to fit its column, so it shrinks proportionally —
  // frame by frame, via ResizeObserver — while the uploader widens beside it, instead of reflowing.
  for (const copy of $$('.hero-a .hero-copy')) {
    const inner = $('.copy-inner', copy);
    const fit = () => {
      if (innerWidth < 1024) { inner.style.removeProperty('--s'); return; }
      inner.style.setProperty('--s', Math.min(1.25, copy.clientWidth / 800).toFixed(4));
    };
    new ResizeObserver(fit).observe(copy);
    fit();
  }
}

// ---------------------------------------------------------------- hero videos: play only while on screen, never for reduced motion
for (const vid of $$('.hero-video')) {
  if (reduceMotion) {
    vid.removeAttribute('autoplay');
    vid.pause();
  } else {
    new IntersectionObserver(([e]) => { if (e.isIntersecting) vid.play().catch(() => {}); else vid.pause(); }).observe(vid);
  }
}

// ---------------------------------------------------------------- uploader + every "quote" button
initUpload({ toast });
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-quote]');
  if (!b) return;
  e.preventDefault();
  menuBtn.setAttribute('aria-expanded', 'false');
  menu.hidden = true;
  openQuote({ service: b.dataset.quote || null, pick: b.hasAttribute('data-pick') });
});

// ---------------------------------------------------------------- reveal on scroll
{
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  const seen = new Map();
  for (const el of $$('.reveal')) {
    const n = seen.get(el.parentElement) || 0;
    seen.set(el.parentElement, n + 1);
    el.style.transitionDelay = `${Math.min(n, 4) * 60}ms`;
    io.observe(el);
  }
}

// ---------------------------------------------------------------- videos
const SHORTS = [
  { id: 'AHzfbXM8QDY', title: 'What is finalREV at its core?', tall: true },
  { id: 'vpx6-avi08A', title: 'Welcome to the Neo-verse' },
  { id: 'lpp-kEV-7OQ', title: 'The future of CNC', tall: true },
  { id: 'KLUhm32uclI', title: 'finalREV shop ASMR', tall: true },
  { id: 'Ay-RfoMUSYE', title: 'Datron MLCube warming up…' },
  { id: '8lwNnjdNLUQ', title: 'Check out the Datron Neo!', tall: true },
  { id: 'sJIbYBgm3AM', title: 'From print to tool tags', tall: true },
  { id: 'zg7RX6R-p-M', title: 'Introducing the Datron MLCube', tall: true },
  { id: 'Xv9BeEzjyKg', title: 'Label tag ASMR', tall: true },
  { id: '78GvXd_8Nug', title: 'Tool organization with the Zoller', tall: true },
  { id: '1aGHOHlHHxQ', title: 'Swift action in the Trinity AX2', tall: true },
];
// 1080×1920 portrait thumbnails where YouTube has them, otherwise the 1280×720 frame (center-cropped)
const thumb = (v) => `https://i.ytimg.com/vi/${v.id}/${v.tall ? 'oar2.jpg' : 'maxresdefault.jpg'}`;
const embed = (id) => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1&modestbranding=1`;

// featured launch film plays inline
{
  const fp = $('#feature-player');
  fp.addEventListener('click', () => {
    fp.parentElement.innerHTML = `<iframe src="${embed(fp.dataset.yt)}" title="finalREV launch video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  });
}

// YouTube's iframe API, fetched on the first play: it reports when a short ends, so its card can shrink back
let ytApi = null;
function loadYT() {
  ytApi ||= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = reject;
    document.head.append(s);
  });
  // blocked (content blockers) or slow: that play falls back to a plain embed
  return Promise.race([ytApi, new Promise((_, reject) => setTimeout(reject, 4000))]);
}

// shorts rail: an endless coverflow strip. On desktop the mouse position steers it —
// towards the right edge scrolls right, the left edge scrolls left, the middle holds still.
// A short plays inside its own card, which grows a little while it plays and eases back when it's over.
{
  const rail = $('#shorts-rail');
  const track = $('#shorts-track');
  const hint = $('#rail-hint');
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const N = SHORTS.length;
  const card = (v, i, clone) => `
    <div class="short" data-i="${i}"${clone ? ' aria-hidden="true"' : ''}>
      <div class="s-frame">
        <button class="s-btn" type="button"${clone ? ' tabindex="-1"' : ''} aria-label="Play: ${v.title}">
          <img alt="" width="1080" height="1920" />
          <span class="s-badge">SHORT</span>
          <span class="s-play"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span>
          <span class="s-meta"><span class="s-num">${String(i + 1).padStart(2, '0')}</span><span class="s-title">${v.title}</span></span>
        </button>
      </div>
      <i class="s-corners" aria-hidden="true"></i>
    </div>`;
  // desktop gets three identical copies so the strip can loop; only the middle one is in the tab order
  track.innerHTML = Array.from({ length: fine ? 3 : 1 }, (_, c) => SHORTS.map((v, i) => card(v, i, fine && c !== 1)).join('')).join('');
  const cards = [...track.children];

  // thumbnails are fetched once each as the rail comes near, then given to every copy together —
  // no per-card lazy loading, so cards never blink in empty while they slide into view
  whenNear(rail, () => SHORTS.forEach((v, i) => {
    const probe = new Image();
    probe.onload = () => {
      // YouTube serves a 120×90 placeholder instead of a 404 when a size is missing
      const src = probe.naturalWidth > 120 ? probe.src : `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;
      $$(`.short[data-i="${i}"] img`, track).forEach((img) => { img.src = src; });
    };
    probe.src = thumb(v);
  }), '900px');

  if (!fine) {
    rail.classList.add('native');
    hint.textContent = 'Swipe to scroll';
  }
  const HINT = hint.textContent;

  // ---- inline player
  let playing = null;            // { card, host, close, player }
  const settling = new Set();    // cards easing back to size after their video
  const settleTimers = new Map();
  let center = (el) => rail.scrollTo({ left: el.offsetLeft - (rail.clientWidth - el.offsetWidth) / 2, behavior: reduceMotion ? 'auto' : 'smooth' });

  function play(el) {
    if (playing?.card === el) return;
    stop();
    const v = SHORTS[+el.dataset.i];
    const host = document.createElement('div');
    host.className = 's-player';
    host.innerHTML = '<div></div>';
    $('.s-frame', el).append(host);
    const close = document.createElement('button');
    close.className = 's-close';
    close.type = 'button';
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>Close';
    close.addEventListener('click', () => stop());
    el.append(close);
    const p = playing = { card: el, host, close, player: null };
    clearTimeout(settleTimers.get(el));
    settling.delete(el);
    el.classList.remove('settling');
    el.classList.add('playing');
    rail.classList.add('playing');
    hint.textContent = fine ? 'Playing · close it to keep scrolling' : 'Playing · swipe on to stop';
    center(el);
    loadYT().then((YT) => {
      if (playing !== p) return;
      p.player = new YT.Player(host.firstChild, {
        host: 'https://www.youtube-nocookie.com',
        videoId: v.id,
        playerVars: { autoplay: 1, rel: 0, playsinline: 1, modestbranding: 1 },
        events: {
          onReady: () => host.classList.add('ready'),
          onStateChange: (e) => { if (e.data === YT.PlayerState.ENDED && playing === p) stop({ ended: true }); },
        },
      });
      p.player.getIframe?.()?.setAttribute('title', v.title);
    }).catch(() => {
      if (playing !== p) return;
      host.innerHTML = `<iframe src="${embed(v.id)}" title="${v.title}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
      host.classList.add('ready');
    });
  }

  // the card shrinks back while the video fades out — slowly when it played to the end
  function stop({ ended = false, instant = false } = {}) {
    const p = playing;
    if (!p) return;
    playing = null;
    const { card: el, host, close, player } = p;
    if (el.contains(document.activeElement)) $('.s-btn', el).focus({ preventScroll: true });
    el.classList.remove('playing');
    rail.classList.remove('playing');
    hint.textContent = HINT;
    host.classList.remove('ready');
    const teardown = () => { try { player?.destroy(); } catch {} host.remove(); close.remove(); };
    if (instant) { teardown(); return; }
    try { player?.pauseVideo(); } catch {}
    setTimeout(teardown, 500);
    const ms = ended ? 1800 : 800;
    el.style.setProperty('--settle', `${ms}ms`);
    el.classList.add('settling');
    settling.add(el);
    settleTimers.set(el, setTimeout(() => { el.classList.remove('settling'); settling.delete(el); }, ms));
  }

  track.addEventListener('click', (e) => {
    const b = e.target.closest('.s-btn');
    if (b) play(b.closest('.short'));
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') stop(); });
  new IntersectionObserver(([e]) => { if (!e.isIntersecting) stop({ instant: true }); }).observe(rail);

  if (!fine) {
    // touch: native swipe scrolling with snap; swiping the playing short away stops it
    const by = (dir) => rail.scrollBy({ left: dir * (cards[0].offsetWidth + 12) * 2, behavior: 'smooth' });
    $('#rail-prev').addEventListener('click', () => by(-1));
    $('#rail-next').addEventListener('click', () => by(1));
    const away = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.target === playing?.card && e.intersectionRatio < 0.5) stop();
    }, { root: rail, threshold: 0.5 });
    cards.forEach((c) => away.observe(c));
  } else {
    let step = 0, setW = 0, cardW = 0, trackTop = 0, trackH = 0;
    let x = 0, v = 0, pointer = null, pointerIn = false, glide = null, focusHold = false, visible = false, raf = 0, last = 0, hot = null;
    const AUTO = reduceMotion ? 0 : 24, VMAX = 1500, DEAD = 0.22;
    function measure() {
      const gap = parseFloat(getComputedStyle(track).columnGap) || 16;
      cardW = cards[0].offsetWidth;
      step = cardW + gap;
      setW = N * step;
      trackTop = track.offsetTop;
      trackH = track.offsetHeight;
      if (!x) x = setW;
    }
    new ResizeObserver(measure).observe(rail);
    measure();
    rail.addEventListener('pointermove', (e) => {
      const r = rail.getBoundingClientRect();
      pointer = (e.clientX - r.left) / r.width;
      const y = e.clientY - r.top - trackTop;
      pointerIn = y >= 0 && y <= trackH;
    });
    rail.addEventListener('pointerleave', () => { pointer = null; });
    rail.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // leave vertical page scrolling alone
      e.preventDefault();
      if (!playing) x += e.deltaX;
    }, { passive: false });
    const glideTo = (to) => { glide = { from: x, to, t: 0 }; };
    const middle = (el) => cards.indexOf(el) * step + cardW / 2 - rail.clientWidth / 2;
    center = (el) => glideTo(middle(el));
    $('#rail-prev').addEventListener('click', () => { stop(); glideTo(x - step * 2); });
    $('#rail-next').addEventListener('click', () => { stop(); glideTo(x + step * 2); });
    track.addEventListener('focusin', (e) => {
      const el = e.target.closest('.short');
      if (!el) return;
      focusHold = true;
      if (!playing) glideTo(middle(el));
    });
    track.addEventListener('focusout', () => { focusHold = false; });

    // move the view by whole copies (invisible — they're identical) and hand the hover state to the twin card
    function shift(n) {
      x -= n * setW;
      if (!hot) return;
      const twin = cards[cards.indexOf(hot) - n * N] || null;
      rail.classList.add('snap');
      hot.classList.remove('hot');
      twin?.classList.add('hot');
      hot = twin;
      void rail.offsetWidth; // apply the swap with transitions off
      rail.classList.remove('snap');
    }

    function frame(now) {
      raf = visible ? requestAnimationFrame(frame) : 0;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const railW = rail.clientWidth;
      const busy = playing || settling.size; // a playing short, or one shrinking back, holds the strip still
      if (glide) {
        glide.t = Math.min(1, glide.t + dt / 0.45);
        const k = glide.t * glide.t * (3 - 2 * glide.t);
        x = glide.from + (glide.to - glide.from) * k;
        v = 0;
        if (glide.t >= 1) glide = null;
      } else {
        let vt = busy || focusHold ? 0 : AUTO;
        if (pointer != null && !busy) {
          const u = (pointer - 0.5) * 2;
          const m = Math.max(0, Math.abs(u) - DEAD) / (1 - DEAD);
          vt = Math.sign(u) * Math.pow(m, 1.6) * VMAX;
        }
        v += (vt - v) * (1 - Math.exp(-dt * 6));
        x += v * dt;
        // keep the view on the middle copy so the strip never runs out
        if (!busy) {
          const n = Math.floor((x - (setW + cardW / 2 - railW / 2)) / setW);
          if (n) shift(n);
        }
      }
      track.style.transform = `translate3d(${-x}px,0,0)`;
      const half = railW / 2;
      for (let k = 0; k < cards.length; k++) {
        const d = Math.min(1, Math.abs(k * step + cardW / 2 - x - half) / half);
        cards[k].style.setProperty('--d', d.toFixed(3));
      }
      // hover highlight: only once the strip has (nearly) stopped, so cards sliding under a resting mouse don't flash
      let want = null;
      if (!playing && !glide && pointer != null && pointerIn && Math.abs(v) < (hot ? 160 : 70)) {
        const px = x + pointer * railW;
        const k = Math.floor(px / step);
        if (px - k * step <= cardW) want = cards[k] || null;
      }
      if (want !== hot) {
        hot?.classList.remove('hot');
        want?.classList.add('hot');
        hot = want;
      }
    }
    new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    }).observe(rail);
  }
}

// ---------------------------------------------------------------- simulator: loaded when near, driven by the capability cards
let simApi = null;
let simLoading = null;
let simMachine = '5x';
function loadSim() {
  simLoading ||= import('./cnc.js?v=6')
    .then((m) => { simApi = m.initCNC({ machine: simMachine }); })
    .catch((err) => { console.error(err); $('#stage-fallback').hidden = false; });
  return simLoading;
}
function whenNear(el, fn, margin = '700px') {
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    io.disconnect();
    fn();
  }, { rootMargin: margin });
  io.observe(el);
}
whenNear($('#live'), loadSim);
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sim]');
  if (!b) return;
  simMachine = b.dataset.sim;
  $('#live').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  loadSim().then(() => simApi?.setMachine(simMachine));
});
