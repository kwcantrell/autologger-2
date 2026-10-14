// node drive.mjs <chromium|firefox|webkit> <baseUrl> [durMs]
import { chromium, firefox, webkit } from 'playwright';
import fs from 'node:fs';
const [name, base, dur = '25000'] = process.argv.slice(2);
const wav = new URL('./tone.wav', import.meta.url).pathname;
const opts = { headless: true };
if (name === 'chromium') opts.args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(fs.existsSync(wav) ? [`--use-file-for-fake-audio-capture=${wav}`] : [])];
if (name === 'firefox') opts.firefoxUserPrefs = { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true };
const ctxOpts = name === 'firefox' ? {} : { permissions: ['microphone'] };
const persistent = process.env.PERSISTENT === '1';
let browser, ctx;
if (persistent) { ctx = await ({ chromium, firefox, webkit })[name].launchPersistentContext(fs.mkdtempSync('/tmp/pw-'), { ...opts, ...ctxOpts }); browser = ctx.browser(); }
else { browser = await ({ chromium, firefox, webkit })[name].launch(opts); ctx = await browser.newContext(ctxOpts); }
const result = { browser: name, persistent, version: browser?.version?.() };
const p1 = await ctx.newPage(); p1.on('console', m => m.type() === 'error' && console.error('[p1]', m.text()));
await p1.goto(`${base}/storage.html`);
const p2 = await ctx.newPage(); await p2.goto(`${base}/storage.html`);
try { result.hold = await p1.evaluate(() => window.spike.hold(20000)); } catch (e) { result.holdError = String(e); }
try { result.probe = await p2.evaluate(() => window.spike.probe()); } catch (e) { result.probeError = String(e); }
await p2.close();
const p3 = await ctx.newPage(); p3.on('console', m => m.type() === 'error' && console.error('[p3]', m.text()));
await p3.goto(`${base}/record.html?upload&tag=${name}${process.env.MIME ? '-mp4' : ''}&dur=${dur}${process.env.MIME ? '&mime=' + encodeURIComponent(process.env.MIME) : ''}`);
try { result.record = await p3.evaluate(() => window.runSpike()); } catch (e) { result.recordError = String(e); }
fs.writeFileSync(new URL(`./out/${name}${persistent ? '-persistent' : ''}${process.env.MIME ? '-mp4' : ''}-result.json`, import.meta.url), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
await ctx.close(); await browser?.close();
