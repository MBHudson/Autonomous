// ============================================
// BROWSERVIEW.JS — the built-in browser screen
// ============================================
//
// A full-window panel that shows whatever an installed Chrome/Edge is looking
// at, and lets the operator drive it too: address bar, Go, click on the page,
// type, read the text. Agents reach the SAME browser through the browser_*
// tools, so an agent can log in (with the operator watching) and then act.
//
// The server does the work (src/Browser.php over the DevTools Protocol); this
// only sends commands and paints the screenshots. It is off unless Config →
// Labs → Browser is on, which the server enforces with a 403.

import { store } from '../store.js?v=315';
import { api } from '../api.js?v=315';
import { esc } from '../utils.js?v=315';

export class BrowserView {
  constructor() {
    this.el = null;
    this.img = null;
    this.open = false;
    this.status = { enabled: false, available: false, running: false };
    this._timer = null;
    this._busy = false;
    // One request at a time per kind. Without these, pressing Go twice (or the
    // Live poll overlapping a slow screenshot) queued requests in the browser's
    // connection pool and the whole screen crawled for minutes.
    this._navBusy = false;
    this._shotBusy = false;
    this._actBusy = false;
  }

  init() {
    const el = document.createElement('div');
    el.className = 'browser-screen';
    el.id = 'browserScreen';
    el.hidden = true;
    el.innerHTML = `
      <div class="bs-head">
        <span class="bs-title">Browser</span>
        <button class="bs-btn" id="bsReload" title="Reload the page">&#8635;</button>
        <input class="bs-url" id="bsUrl" placeholder="https://…" spellcheck="false" autocomplete="off">
        <button class="bs-btn primary" id="bsGo">Go</button>
        <button class="bs-btn" id="bsLive" title="Refresh the view automatically">Live</button>
        <label class="bs-check" title="Headless has no window; untick to watch a real window">
          <input type="checkbox" id="bsHeadless" checked> headless
        </label>
        <button class="bs-btn" id="bsStartStop">Launch</button>
        <span class="bs-status" id="bsStatus"></span>
        <button class="bs-x" id="bsClose" title="Close">&#10005;</button>
      </div>
      <div class="bs-body">
        <div class="bs-view"><img id="bsImg" alt="browser view"></div>
        <div class="bs-side">
          <div class="bs-side-h">Drive it</div>
          <textarea class="bs-type" id="bsType" rows="3" placeholder="Type into the focused field…  (Ctrl/⌘+Enter sends)"></textarea>
          <div class="bs-side-row">
            <button class="bs-btn" id="bsTypeSend">Send text</button>
            <button class="bs-btn" id="bsEnter">Enter</button>
          </div>
          <button class="bs-btn" id="bsRead">Read page text</button>
          <pre class="bs-text" id="bsText"></pre>
          <div class="bs-hint">Agents use the browser_* tools on this same page. Log in once here and the session sticks.</div>
        </div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.img = el.querySelector('#bsImg');

    el.querySelector('#bsClose').addEventListener('click', () => this.hide());
    el.querySelector('#bsGo').addEventListener('click', () => this.go());
    el.querySelector('#bsUrl').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.go(); }
    });
    el.querySelector('#bsReload').addEventListener('click', () => this.shot());
    el.querySelector('#bsLive').addEventListener('click', (e) => this._toggleLive(e.currentTarget));
    el.querySelector('#bsStartStop').addEventListener('click', () => this._startStop());
    el.querySelector('#bsTypeSend').addEventListener('click', () => this.sendText());
    el.querySelector('#bsEnter').addEventListener('click', () => this.press('Enter'));
    el.querySelector('#bsRead').addEventListener('click', () => this.readText());
    el.querySelector('#bsType').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.sendText(); }
    });
    this.img.addEventListener('click', (e) => this._click(e));
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.open) return;
      // Never close the screen while the operator is typing in it.
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      this.hide();
    });
    this.refreshStatus();
  }

  async refreshStatus() {
    try {
      this.status = { ...this.status, ...(await api.browserStatus()) };
    } catch { /* leave the last known */ }
    this._paintStatus();
  }

  _paintStatus() {
    const s = this.status;
    const st = this.el.querySelector('#bsStatus');
    const startStop = this.el.querySelector('#bsStartStop');
    const disabled = !s.enabled || !s.available;
    ['bsGo', 'bsReload', 'bsLive', 'bsStartStop', 'bsTypeSend', 'bsEnter', 'bsRead'].forEach((id) => {
      const b = this.el.querySelector('#' + id);
      if (b) b.disabled = disabled;
    });
    if (!s.enabled) { st.textContent = 'Off — turn on in Config → Labs → Browser.'; return; }
    if (!s.available) { st.textContent = 'No Chrome or Edge found on this machine.'; return; }
    st.textContent = s.running ? `running on :${s.port}` : 'not running';
    startStop.textContent = s.running ? 'Stop' : 'Launch';
    startStop.disabled = false;
  }

  show() {
    this.open = true;
    this.el.hidden = false;
    this.refreshStatus().then(() => { if (this.status.running) this.shot(); });
  }
  hide() {
    this.open = false;
    this.el.hidden = true;
    this._stopLive();
  }
  toggle() { this.open ? this.hide() : this.show(); }

  _toast(message, type = 'info') {
    try { store.emit('toast', { message, type }); } catch { /* no store */ }
  }

  async _startStop() {
    if (this._busy) return;
    this._busy = true;
    try {
      if (this.status.running) {
        await api.browserStop();
        this._toast('Browser stopped');
      } else {
        const headless = this.el.querySelector('#bsHeadless').checked;
        this._toast(headless ? 'Starting headless browser…' : 'Starting the browser window…');
        await api.browserLaunch(headless);
        this._toast('Browser ready');
      }
    } catch (e) {
      this._toast(`Browser: ${e.message}`, 'error');
    } finally {
      this._busy = false;
      await this.refreshStatus();
      if (this.status.running) this.shot();
    }
  }

  async go() {
    if (this._navBusy) return;
    const url = this.el.querySelector('#bsUrl').value.trim();
    if (!url) return;
    this._navBusy = true;
    const st = this.el.querySelector('#bsStatus');
    if (st) st.textContent = 'loading…';
    try {
      const info = await api.browserNavigate(url);
      if (info && info.url) this.el.querySelector('#bsUrl').value = info.url;
      await this.shot();
    } catch (e) {
      this._toast(`Navigate: ${e.message}`, 'error');
    } finally {
      this._navBusy = false;
      this._paintStatus();
    }
  }

  async shot() {
    if (!this.status.running || this._shotBusy) return;
    this._shotBusy = true;
    try {
      const res = await api.browserScreenshot();
      if (res && res.png) this.img.src = 'data:image/png;base64,' + res.png;
    } catch { /* keep the last frame */ }
    finally { this._shotBusy = false; }
  }

  _toggleLive(btn) {
    if (this._timer) { this._stopLive(); return; }
    btn.classList.add('active');
    this._timer = setInterval(() => {
      if (!this.open || !this.status.running) { this._stopLive(); return; }
      if (!this._shotBusy) this.shot();
    }, 2000);
  }
  _stopLive() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.el?.querySelector('#bsLive')?.classList.remove('active');
  }

  async _click(e) {
    if (!this.status.running || this._actBusy) return;
    this._actBusy = true;
    try {
      const rect = this.img.getBoundingClientRect();
      const nx = this.img.naturalWidth || rect.width;
      const ny = this.img.naturalHeight || rect.height;
      const x = (e.clientX - rect.left) * (nx / rect.width);
      const y = (e.clientY - rect.top) * (ny / rect.height);
      await api.browserClick(Math.round(x), Math.round(y));
      await this.shot();
    } catch (err) { this._toast(`Click: ${err.message}`, 'error'); }
    finally { this._actBusy = false; }
  }

  async sendText() {
    if (this._actBusy) return;
    const box = this.el.querySelector('#bsType');
    const text = box.value;
    if (!text) return;
    this._actBusy = true;
    try { await api.browserType(text); box.value = ''; await this.shot(); }
    catch (e) { this._toast(`Type: ${e.message}`, 'error'); }
    finally { this._actBusy = false; }
  }

  async press(key) {
    if (this._actBusy) return;
    this._actBusy = true;
    try { await api.browserKey(key); await this.shot(); }
    catch (e) { this._toast(`Key: ${e.message}`, 'error'); }
    finally { this._actBusy = false; }
  }

  async readText() {
    try {
      const res = await api.browserRead();
      this.el.querySelector('#bsText').textContent = String(res.text || '').slice(0, 20000);
    } catch (e) { this._toast(`Read: ${e.message}`, 'error'); }
  }

  dispose() { this._stopLive(); this.el?.remove(); }
}

export default BrowserView;
