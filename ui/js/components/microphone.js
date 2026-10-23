// ============================================
// MICROPHONE.JS — Speech-to-text
// ============================================

import { store } from '../store.js?v=301';

export class Microphone {
  constructor() {
    this.btn = null;
    this.recognition = null;
    this.isListening = false;
    this.isSupported = false;
  }

  init() {
    this.btn = document.getElementById('micBtn');
    if (!this.btn) return;

    // Check for Web Speech API support
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      this.btn.style.display = 'none';
      return;
    }

    this.isSupported = true;
    this.recognition = new SpeechRecognition();
    this.recognition.continuous = false;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      const input = document.getElementById('inputField');
      if (input) {
        input.value = transcript;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      }
    };

    this.recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      this._stopListening();
      if (event.error === 'not-allowed') {
        store.emit('toast', { message: 'Microphone access denied', type: 'error' });
      }
    };

    this.recognition.onend = () => {
      this._stopListening();
    };

    this.btn.addEventListener('click', () => this.toggle());
  }

  toggle() {
    if (this.isListening) {
      this._stopListening();
    } else {
      this._startListening();
    }
  }

  _startListening() {
    if (!this.recognition) return;
    try {
      this.recognition.start();
      this.isListening = true;
      this.btn.classList.add('listening');
      this.btn.innerHTML = '&#9209;';
      this.btn.title = 'Stop listening';
    } catch (err) {
      console.error('Failed to start recognition:', err);
    }
  }

  _stopListening() {
    if (this.recognition && this.isListening) {
      this.recognition.stop();
    }
    this.isListening = false;
    if (this.btn) {
      this.btn.classList.remove('listening');
      this.btn.innerHTML = '&#127908;';
      this.btn.title = 'Speech to text';
    }
  }

  destroy() {
    this._stopListening();
  }
}

export default Microphone;
