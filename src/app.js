// @ts-check
import { GRAMMAR, describe, stripCommands } from './commands.js';
import { buildPlan, srcToOut, fmt, toSrt, toVtt, youtubeChapters, DEFAULTS } from './plan.js';
import { Recorder, canRecord, canTranscribe } from './recorder.js';
import { Player, VideoSource, SampleSource, CameraTrack, exportVideo, exportFormat } from './player.js';
import { buildSampleTake } from './sample.js';
import { saveTake, loadTake, prefs } from './store.js';
import { DEFAULT_LOOK } from './render.js';

/** @typedef {import('./plan.js').Plan} Plan */
/** @typedef {import('./plan.js').Take} Take */

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} id */
const input = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

const COLORS = {
  cut: 'var(--cut)', hide: 'var(--blur)', zoomIn: 'var(--zoom)', zoomOut: 'var(--zoom)', highlight: 'var(--spot)',
  speedUp: 'var(--speed)', normalSpeed: 'var(--speed)', chapter: 'var(--text)', title: 'var(--text)', mark: 'var(--muted)',
  camBig: '#3ecf6f', camSmall: '#3ecf6f', camHide: '#3ecf6f', camShow: '#3ecf6f',
};

const HINDI = {
  cut: 'kaat do · काट दो', hide: 'chhupa do · छुपा दो', zoomIn: 'zoom karo · ज़ूम करो', zoomOut: 'zoom out karo',
  highlight: 'yahan dekho · यहाँ देखो', speedUp: 'tez karo · तेज़ करो', normalSpeed: 'normal karo', chapter: 'अध्याय: …',
  title: 'टाइटल: …', mark: '',
  camBig: 'camera bada karo', camSmall: 'camera chhota karo', camHide: 'camera band karo', camShow: 'camera chalu karo',
};

const DOES = {
  cut: 'Cuts the sentence you just fumbled, and anything you did on screen while saying it.',
  hide: 'Blurs whatever just appeared on screen, from the moment it appeared until it leaves the screen.',
  zoomIn: 'Smoothly zooms into the part of the screen that just changed.',
  zoomOut: 'Eases back to the full screen.',
  highlight: 'Dims the screen and rings what just changed for three seconds.',
  speedUp: 'Fast-forwards until you say “normal speed”, with a badge so viewers know.',
  normalSpeed: 'Ends the fast-forward.',
  chapter: 'Starts a chapter with an on-screen card, and a YouTube timestamp.',
  title: 'Puts a title card on the opening seconds.',
  mark: 'Drops a bookmark you can jump to in the editor.',
  camBig: 'Grows your camera bubble to fill the frame, for intros and outros.',
  camSmall: 'Sends your camera back to its corner. “Back to the screen” works too.',
  camHide: 'Hides your camera bubble when it covers something.',
  camShow: 'Brings the camera bubble back.',
};

// ---------------------------------------------------------------- state

const state = {
  /** @type {(Take & {kind: string, width: number, height: number, thumbs: {t: number, url: string}[], levelThreshold?: number, blob?: Blob}) | null} */
  take: null,
  /** @type {Plan | null} */
  plan: null,
  /** @type {Plan | null} */
  raw: null,
  showRaw: false,
  /** @type {string[]} */
  disabled: [],
  /** @type {Player | null} */
  player: null,
  look: { ...DEFAULT_LOOK },
  /** @type {AbortController | null} */
  exporting: null,
};

function options() {
  return {
    trimDeadAir: input('opt-dead').checked,
    speed: Number(/** @type {HTMLSelectElement} */ ($('opt-speed')).value),
    zoom: Number(/** @type {HTMLSelectElement} */ ($('opt-zoom')).value),
    levelThreshold: state.take?.levelThreshold ?? DEFAULTS.levelThreshold,
    disabled: state.disabled,
  };
}

function rebuild() {
  if (!state.take) return;
  state.plan = buildPlan(state.take, options());
  const raw = buildPlan(state.take, { ...options(), trimDeadAir: false, disabled: state.plan.commands.map((c) => c.id) });
  state.raw = { ...raw, captions: [] };
  renderEditor();
}

const currentPlan = () => /** @type {Plan} */ (state.showRaw ? state.raw : state.plan);

// ---------------------------------------------------------------- screens

/** @param {'home'|'rec'|'edit'} name */
function show(name) {
  for (const id of ['home', 'rec', 'edit']) $(id).hidden = id !== name;
  window.scrollTo({ top: 0 });
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;
/** @param {string} msg */
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

// ---------------------------------------------------------------- home

function renderVocab() {
  $('vocab').replaceChildren(
    ...GRAMMAR.map((g) => {
      const li = document.createElement('li');
      const say = document.createElement('span');
      say.className = 'say';
      say.textContent = g.say;
      const does = document.createElement('span');
      does.className = 'does';
      does.textContent = DOES[g.type];
      li.append(say, does);
      if (HINDI[g.type]) {
        const alias = document.createElement('span');
        alias.className = 'alias';
        alias.textContent = `Also: ${HINDI[g.type]}`;
        li.append(alias);
      }
      return li;
    }),
  );
}

// ---------------------------------------------------------------- recording

/** @type {Recorder | null} */
let recorder = null;
/** @type {ReturnType<typeof setInterval> | undefined} */
let hudTimer;
/** @type {Window | null} */
let pip = null;

async function startRecording() {
  if (!canRecord()) {
    note('support-note', 'Recording needs Chrome, Edge or Firefox on a computer. You can still try the sample take.');
    return;
  }
  const lang = /** @type {HTMLSelectElement} */ ($('lang')).value;
  prefs.set('lang', lang);
  $('hud-log').replaceChildren();
  $('hud-heard').textContent = 'Listening…';
  $('hud-interim').textContent = '';
  recorder = new Recorder({
    onInterim: (t) => ($('hud-interim').textContent = t),
    onPhrase: (p) => ($('hud-heard').textContent = p.text),
    onCommand: (c) => logCommand(c),
    onLevel: (v) => ($('hud-level').style.width = `${Math.min(100, v * 600)}%`),
    onEnded: () => stopRecording(),
    onWarn: (m) => toast(m),
  });
  try {
    prefs.set('camera', input('camera').checked ? '1' : '0');
    await recorder.start({ lang, systemAudio: input('system-audio').checked, camera: input('camera').checked });
  } catch (e) {
    recorder = null;
    if (/** @type {any} */ (e)?.name === 'NotAllowedError') return; // they cancelled the picker
    note('support-note', /** @type {Error} */ (e).message || 'Recording could not start.');
    return;
  }
  show('rec');
  const tick = () => ($('hud-time').textContent = fmt(recorder?.now() ?? 0));
  tick();
  hudTimer = setInterval(tick, 250);
  if (!canTranscribe()) toast('This browser can’t hear directions. The video still records.');
}

/** @param {import('./commands.js').Command} c */
function logCommand(c) {
  const li = document.createElement('li');
  li.style.borderLeftColor = COLORS[c.type];
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = fmt(c.time);
  const what = document.createElement('span');
  what.className = 'what';
  what.textContent = describe(c);
  const heard = document.createElement('span');
  heard.className = 'heard';
  heard.textContent = `“${c.heard}”`;
  what.append(heard);
  li.append(when, what);
  $('hud-log').prepend(li);
}

async function stopRecording() {
  if (!recorder) return;
  const r = recorder;
  recorder = null;
  clearInterval(hudTimer);
  closePip();
  $('hud-heard').textContent = 'Putting your take together…';
  const take = await r.stop();
  if (take.duration < 1) {
    show('home');
    toast('That take was too short.');
    return;
  }
  void saveTake(take);
  await openTake(take);
}

async function popOut() {
  const dpip = /** @type {any} */ (window).documentPictureInPicture;
  if (!dpip) {
    toast('Floating slate needs Chrome or Edge 116+.');
    return;
  }
  pip = await dpip.requestWindow({ width: 360, height: 420 });
  const doc = /** @type {Window} */ (pip).document;
  doc.documentElement.classList.add('pip');
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) doc.head.append(link.cloneNode());
  doc.body.append($('hud'));
  /** @type {Window} */ (pip).addEventListener('pagehide', () => {
    $('rec').append($('hud'));
    pip = null;
  });
}

function closePip() {
  if (pip) {
    $('rec').append($('hud'));
    pip.close();
    pip = null;
  }
}

// ---------------------------------------------------------------- editor

/** @param {any} take */
async function openTake(take) {
  state.player?.destroy();
  state.take = take;
  state.disabled = [];
  state.showRaw = false;

  /** @type {import('./player.js').Source} */
  let source;
  if (take.kind === 'sample') {
    source = new SampleSource();
    $('take-kind').textContent = 'The sample take · a developer demoing a weather app';
  } else {
    const vs = new VideoSource(take.blob, take.duration);
    try {
      await vs.ready();
    } catch (e) {
      toast(/** @type {Error} */ (e).message);
      show('home');
      return;
    }
    if (take.camBlob) {
      const cam = new CameraTrack(take.camBlob, take.camOffset || 0, take.duration);
      try {
        await cam.ready();
        vs.camera = cam;
      } catch {
        toast('The camera recording could not be opened; showing the screen only.');
      }
    }
    source = vs;
    $('take-kind').textContent = `Your take · ${new Date(take.createdAt).toLocaleString()}`;
  }
  // Export at the source's resolution, capped at 1080p, even dimensions.
  const canvas = /** @type {HTMLCanvasElement} */ ($('screen'));
  const scale = Math.min(1, 1920 / source.width, 1080 / source.height);
  canvas.width = Math.round((source.width * scale) / 2) * 2;
  canvas.height = Math.round((source.height * scale) / 2) * 2;
  canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;

  rebuild();
  const player = new Player(canvas, source, currentPlan, () => state.look);
  state.player = player;
  player.onTime = (o) => renderTime(o);
  player.onEnd = () => setPlaying(false);

  const fmtInfo = exportFormat();
  $('export').textContent = fmtInfo ? `Export ${fmtInfo.ext.toUpperCase()} video` : 'Export not supported here';
  /** @type {HTMLButtonElement} */ ($('export')).disabled = !fmtInfo;
  $('download-video').hidden = true;

  const warn = $('edit-warn');
  warn.hidden = take.phrases.length > 0;
  warn.textContent = 'Retake didn’t hear any words in this take, so there were no directions to follow. Check that your microphone is on and you’re using Chrome or Edge.';

  $('cam-opts').hidden = !source.camera;
  renderFilm();
  show('edit');
  await player.seekOut(0);
}

function renderEditor() {
  const plan = /** @type {Plan} */ (state.plan);
  const s = plan.stats;
  const saved = $('saved');
  saved.replaceChildren('Retake saved you ', Object.assign(document.createElement('em'), { textContent: `${Math.round(s.removed)}s` }));

  /** @type {[string, string][]} */
  const chips = [];
  if (s.fumbles) chips.push(['var(--cut)', `${s.fumbles} fumble${s.fumbles > 1 ? 's' : ''} cut`]);
  if (s.deadAir > 0.5) chips.push(['var(--air)', `${Math.round(s.deadAir)}s dead air trimmed`]);
  if (s.sped > 0.5) chips.push(['var(--speed)', `${Math.round(s.sped)}s fast-forwarded`]);
  if (s.hidden) chips.push(['var(--blur)', `${s.hidden} secret${s.hidden > 1 ? 's' : ''} hidden`]);
  if (s.zooms) chips.push(['var(--zoom)', `${s.zooms} zoom${s.zooms > 1 ? 's' : ''}`]);
  if (s.chapters) chips.push(['var(--text)', `${s.chapters} chapter${s.chapters > 1 ? 's' : ''}`]);
  chips.push(['var(--faint)', `${fmt(plan.duration)} → ${fmt(plan.outDuration)}`]);
  $('chips').replaceChildren(
    ...chips.map(([color, text]) => {
      const li = document.createElement('li');
      const i = document.createElement('i');
      i.style.background = color;
      li.append(i, text);
      return li;
    }),
  );

  renderBands();
  renderNotes();
  renderWords();
  renderExtras();
  $('raw-len').textContent = fmt(plan.duration);
  if (state.player) {
    const cur = currentPlan();
    state.player.out = srcToOut(cur.segments, state.player.source.time(), cur.outDuration);
    state.player.paint();
    renderTime(state.player.out);
  }
}

function renderFilm() {
  const take = /** @type {any} */ (state.take);
  $('film').replaceChildren(
    ...take.thumbs.map((/** @type {{url: string}} */ th) => {
      const img = document.createElement('img');
      img.src = th.url;
      img.alt = '';
      return img;
    }),
  );
}

function renderBands() {
  const plan = /** @type {Plan} */ (state.plan);
  const D = plan.duration;
  const pct = (/** @type {number} */ t) => `${(Math.max(0, Math.min(D, t)) / D) * 100}%`;
  /** @param {string} cls @param {number} a @param {number} b @param {string} title */
  const band = (cls, a, b, title) => {
    const el = document.createElement('div');
    el.className = `band ${cls}`;
    el.style.left = pct(a);
    if (cls !== 'chap') el.style.width = `${(Math.max(0, Math.min(D, b) - Math.max(0, a)) / D) * 100}%`;
    el.title = title;
    return el;
  };
  const els = [
    ...plan.cuts.map((c) => band(c.reason === 'dead-air' ? 'air' : 'cut', c.src0, c.src1, c.reason === 'dead-air' ? 'Dead air trimmed' : c.reason === 'fumble' ? 'Fumble cut' : 'Direction removed')),
    ...plan.speeds.map((s) => band('speed', s.src0, s.src1, `Fast-forward ${s.rate}×`)),
    ...plan.zooms.map((z) => band('zoom', z.src0, z.src1, `Zoom ${z.scale}×`)),
    ...plan.blurs.map((b) => band('blur', b.src0, b.src1, 'Hidden')),
    ...plan.spots.map((s) => band('spot', s.src0, s.src1, 'Spotlight')),
    ...plan.chapters.map((c) => band('chap', c.src, c.src, `Chapter: ${c.title}`)),
  ];
  $('bands').replaceChildren(...els);
}

function renderNotes() {
  const plan = /** @type {Plan} */ (state.plan);
  const list = $('notes');
  if (!plan.commands.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No directions in this take. Dead air was still trimmed and captions added.';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...plan.commands.map((c) => {
      const li = document.createElement('li');
      li.className = 'note-item';
      li.dataset.on = String(c.enabled);
      const stripe = document.createElement('span');
      stripe.className = 'stripe';
      stripe.style.background = COLORS[c.type];
      const body = document.createElement('div');
      const what = document.createElement('div');
      what.className = 'note-what';
      what.textContent = describe(c);
      const meta = document.createElement('div');
      meta.className = 'note-meta';
      const tc = document.createElement('span');
      tc.className = 'tc';
      tc.textContent = fmt(c.time);
      meta.append(tc, `you said “${c.heard}”`);
      body.append(what, meta);
      if (c.enabled && c.effect) {
        const eff = document.createElement('div');
        eff.className = 'note-effect';
        eff.textContent = c.effect;
        body.append(eff);
      }
      const sw = document.createElement('label');
      sw.className = 'switch';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = c.enabled;
      box.id = `cmd-${c.id}`;
      box.setAttribute('aria-label', `${describe(c)} at ${fmt(c.time)}`);
      box.addEventListener('click', (e) => e.stopPropagation());
      box.addEventListener('change', () => {
        state.disabled = box.checked ? state.disabled.filter((d) => d !== c.id) : [...state.disabled, c.id];
        rebuild();
        toast(box.checked ? `Redone: ${describe(c)}` : `Undone: ${describe(c)}`);
      });
      sw.append(box, document.createElement('span'));
      li.append(stripe, body, sw);
      li.addEventListener('click', () => jumpToSource(c.time - 2.5));
      return li;
    }),
  );
}

function renderWords() {
  const plan = /** @type {Plan} */ (state.plan);
  const take = /** @type {Take} */ (state.take);
  const cutAt = (/** @type {number} */ t) => plan.cuts.some((c) => t >= c.src0 && t < c.src1);
  $('words').replaceChildren(
    ...take.phrases.map((p, i) => {
      const li = document.createElement('li');
      const isCmd = plan.commands.some((c) => c.phrase === i && c.enabled);
      li.dataset.cut = String(cutAt((p.start + p.end) / 2));
      const tc = document.createElement('span');
      tc.className = 'tc';
      tc.textContent = fmt(p.start);
      const w = document.createElement('span');
      w.className = 'w';
      if (isCmd) {
        const m = document.createElement('mark');
        m.textContent = p.text;
        w.append(m);
      } else w.textContent = p.text;
      li.append(tc, w);
      li.addEventListener('click', () => jumpToSource(p.start));
      return li;
    }),
  );
}

function renderExtras() {
  const plan = /** @type {Plan} */ (state.plan);
  const yt = youtubeChapters(plan);
  /** @type {HTMLTextAreaElement} */ ($('yt-chapters')).value = yt.text || '';
  $('yt-note').textContent = yt.reason;
}

/** @param {number} out */
function renderTime(out) {
  const plan = currentPlan();
  if (!plan) return;
  $('tc').textContent = `${fmt(out)} / ${fmt(plan.outDuration)}`;
  /** @type {HTMLInputElement} */ ($('scrub')).value = String(Math.round((out / Math.max(0.01, plan.outDuration)) * 1000));
  const src = state.player?.source.time() ?? 0;
  $('playhead').style.left = `${(src / plan.duration) * 100}%`;
}

/** @param {number} t */
function jumpToSource(t) {
  const plan = currentPlan();
  void state.player?.seekOut(srcToOut(plan.segments, Math.max(0, t), plan.outDuration));
}

/** @param {boolean} on */
function setPlaying(on) {
  $('big-play').hidden = on;
  $('play-icon').setAttribute('d', on ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z');
  $('play').setAttribute('aria-label', on ? 'Pause' : 'Play');
}

async function togglePlay() {
  const p = state.player;
  if (!p || state.exporting) return;
  if (p.playing) {
    p.pause();
    setPlaying(false);
  } else {
    setPlaying(true);
    await p.play();
  }
}

/** @param {boolean} raw */
async function setRaw(raw) {
  const p = state.player;
  if (!p || state.exporting) return;
  const wasPlaying = p.playing;
  const src = p.source.time();
  p.pause();
  state.showRaw = raw;
  $('ab-edit').setAttribute('aria-pressed', String(!raw));
  $('ab-raw').setAttribute('aria-pressed', String(raw));
  const plan = currentPlan();
  await p.seekOut(srcToOut(plan.segments, src, plan.outDuration));
  if (wasPlaying) await p.play();
}

// ---------------------------------------------------------------- export

/** @param {Blob} blob @param {string} name */
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function baseName() {
  const d = new Date();
  return `retake-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

async function runExport() {
  const p = state.player;
  if (!p || state.exporting) return;
  if (state.showRaw) await setRaw(false);
  state.exporting = new AbortController();
  /** @type {HTMLButtonElement} */ ($('export')).disabled = true;
  $('export-progress').hidden = false;
  $('download-video').hidden = true;
  setPlaying(true);
  try {
    const { blob, ext } = await exportVideo(
      p,
      (f) => {
        $('export-bar').style.width = `${f * 100}%`;
        $('export-pct').textContent = `${Math.round(f * 100)}%`;
      },
      { signal: state.exporting.signal },
    );
    const a = /** @type {HTMLAnchorElement} */ ($('download-video'));
    a.href = URL.createObjectURL(blob);
    a.download = `${baseName()}.${ext}`;
    a.textContent = `Download video (${(blob.size / 1e6).toFixed(1)} MB)`;
    a.hidden = false;
    toast('Your video is ready.');
  } catch (e) {
    if (/** @type {any} */ (e)?.name !== 'AbortError') toast(/** @type {Error} */ (e).message || 'Export failed.');
  } finally {
    state.exporting = null;
    setPlaying(false);
    $('export-progress').hidden = true;
    /** @type {HTMLButtonElement} */ ($('export')).disabled = false;
  }
}

/** @param {string} id @param {string} msg */
function note(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.hidden = false;
}

// ---------------------------------------------------------------- wire up

function selectTab(/** @type {string} */ name) {
  for (const t of ['notes', 'look', 'words', 'export']) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`panel-${t}`).hidden = t !== name;
  }
}

async function init() {
  renderVocab();
  if (prefs.get('camera') === '0') input('camera').checked = false;
  const lang = prefs.get('lang');
  if (lang) /** @type {HTMLSelectElement} */ ($('lang')).value = lang;

  if (!canRecord()) note('support-note', 'Recording needs Chrome, Edge or Firefox on a computer. You can still try the sample take.');
  else if (!canTranscribe()) note('support-note', 'This browser can record, but only Chrome and Edge can hear your directions.');

  $('record').addEventListener('click', startRecording);
  $('stop').addEventListener('click', stopRecording);
  $('pop-out').addEventListener('click', popOut);
  $('try-sample').addEventListener('click', async () => {
    $('try-sample').textContent = 'Loading…';
    await new Promise((r) => setTimeout(r, 30));
    await openTake(buildSampleTake());
    $('try-sample').textContent = 'Try the sample take';
  });
  $('open-last').addEventListener('click', async () => {
    const t = await loadTake();
    if (t) await openTake(t);
  });
  loadTake().then((t) => ($('open-last').hidden = !t));

  $('play').addEventListener('click', togglePlay);
  $('big-play').addEventListener('click', togglePlay);
  $('screen').addEventListener('click', togglePlay);
  $('ab-edit').addEventListener('click', () => setRaw(false));
  $('ab-raw').addEventListener('click', () => setRaw(true));
  $('scrub').addEventListener('input', () => {
    const plan = currentPlan();
    void state.player?.seekOut((Number(input('scrub').value) / 1000) * plan.outDuration);
  });
  const tl = $('timeline');
  tl.addEventListener('click', (e) => {
    const r = tl.getBoundingClientRect();
    jumpToSource(((e.clientX - r.left) / r.width) * currentPlan().duration);
  });
  tl.addEventListener('keydown', (e) => {
    const src = state.player?.source.time() ?? 0;
    if (e.key === 'ArrowRight') jumpToSource(src + 5);
    if (e.key === 'ArrowLeft') jumpToSource(src - 5);
  });
  for (const t of ['notes', 'look', 'words', 'export']) $(`tab-${t}`).addEventListener('click', () => selectTab(t));

  for (const id of ['opt-dead', 'opt-speed', 'opt-zoom']) $(id).addEventListener('change', rebuild);
  const lookChanged = () => {
    state.look = {
      captions: input('opt-captions').checked,
      captionSize: Number(input('opt-capsize').value) / 1000,
      badge: input('opt-badge').checked,
      watermark: input('opt-mark').checked,
      camera: input('opt-cam').checked,
      camShape: /** @type {'circle'|'rounded'} */ (/** @type {HTMLSelectElement} */ ($('opt-camshape')).value),
      camCorner: /** @type {'br'|'bl'|'tr'|'tl'} */ (/** @type {HTMLSelectElement} */ ($('opt-camcorner')).value),
      camSize: Number(input('opt-camsize').value) / 100,
    };
    state.player?.paint();
  };
  for (const id of ['opt-captions', 'opt-capsize', 'opt-badge', 'opt-mark', 'opt-cam', 'opt-camshape', 'opt-camcorner', 'opt-camsize']) {
    $(id).addEventListener('input', lookChanged);
    $(id).addEventListener('change', lookChanged);
  }

  $('export').addEventListener('click', runExport);
  $('export-cancel').addEventListener('click', () => state.exporting?.abort());
  $('dl-srt').addEventListener('click', () => download(new Blob([toSrt(/** @type {Plan} */ (state.plan).captions)], { type: 'text/plain' }), `${baseName()}.srt`));
  $('dl-vtt').addEventListener('click', () => download(new Blob([toVtt(/** @type {Plan} */ (state.plan).captions)], { type: 'text/vtt' }), `${baseName()}.vtt`));
  $('dl-txt').addEventListener('click', () => {
    const plan = /** @type {Plan} */ (state.plan);
    const text = plan.captions.map((c) => `[${fmt(c.out0)}] ${c.text}`).join('\n');
    download(new Blob([text], { type: 'text/plain' }), `${baseName()}-transcript.txt`);
  });
  $('copy-chapters').addEventListener('click', async () => {
    const ta = /** @type {HTMLTextAreaElement} */ ($('yt-chapters'));
    try {
      await navigator.clipboard.writeText(ta.value);
    } catch {
      ta.select();
    }
    toast('Chapters copied');
  });

  document.addEventListener('keydown', (e) => {
    if ($('edit').hidden || /** @type {HTMLElement} */ (e.target).closest('input, select, textarea')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      void togglePlay();
    }
  });

  // Deep link for judges: ?sample opens the sample take straight away.
  if (new URLSearchParams(location.search).has('sample')) $('try-sample').click();
}

void init();

// Exposed for the demo checklist in the README and for automated checks.
/** @type {any} */ (window).retake = { state, stripCommands };
