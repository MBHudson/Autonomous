/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// EXPORT.JS — Export functionality
// ============================================

import { store } from '../store.js?v=349';
import { api } from '../api.js?v=349';
import { esc, formatTime, downloadFile, agentCode } from '../utils.js?v=349';

export class ExportPanel {
  constructor() {
    this.modal = null;
    this.selectedFormat = 'json';
  }

  init() {
    store.on('export:open', () => this.open());
  }

  open() {
    const conv = store.get('currentConversation');
    if (!conv) {
      store.emit('toast', { message: 'No conversation to export', type: 'warning' });
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'exportModalOverlay';

    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">Export Session</span>
          <button class="modal-close" id="exportModalClose">&times;</button>
        </div>
        <div class="modal-body">
          <div class="export-formats">
            <button class="export-format-btn selected" data-format="json">JSON</button>
            <button class="export-format-btn" data-format="markdown">Markdown</button>
            <button class="export-format-btn" data-format="text">Text</button>
          </div>
          <div class="export-preview" id="exportPreview"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="exportCancel">Cancel</button>
          <button class="btn btn-primary" id="exportDownload">Download</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    this.modal = overlay;

    // Close handlers
    document.getElementById('exportModalClose').addEventListener('click', () => this.close());
    document.getElementById('exportCancel').addEventListener('click', () => this.close());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });

    // Format selection
    overlay.querySelectorAll('.export-format-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.export-format-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this.selectedFormat = btn.dataset.format;
        this._updatePreview();
      });
    });

    // Download
    document.getElementById('exportDownload').addEventListener('click', () => this._download());

    // Initial preview
    this._updatePreview();
  }

  _updatePreview() {
    const conv = store.get('currentConversation');
    if (!conv) return;

    const preview = document.getElementById('exportPreview');
    if (!preview) return;

    let content = '';
    switch (this.selectedFormat) {
      case 'json':
        content = JSON.stringify(conv, null, 2);
        break;
      case 'markdown':
        content = this._toMarkdown(conv);
        break;
      case 'text':
        content = this._toText(conv);
        break;
    }

    preview.textContent = content.slice(0, 2000) + (content.length > 2000 ? '\n... (truncated)' : '');
  }

  _toMarkdown(conv) {
    let md = `# ${conv.title}\n\n`;
    md += `**Created:** ${formatTime(conv.createdAt)}\n`;
    md += `**Messages:** ${(conv.messages || []).length}\n\n`;
    md += `---\n\n`;

    (conv.messages || []).forEach(msg => {
      const time = formatTime(msg.timestamp);
      if (msg.role === 'user') {
        md += `## You (${time})\n\n${msg.content}\n\n`;
      } else {
        const agent = store.get('agents').find(a => a.id === msg.agentId);
        const name = agent ? `${agentCode(agent)} ${agent.name}` : 'Agent';
        md += `## ${name} (${time})\n\n${msg.content}\n\n`;
      }
      md += `---\n\n`;
    });

    return md;
  }

  _toText(conv) {
    let txt = `Session: ${conv.title}\n`;
    txt += `Created: ${formatTime(conv.createdAt)}\n`;
    txt += `Messages: ${(conv.messages || []).length}\n`;
    txt += `${'='.repeat(40)}\n\n`;

    (conv.messages || []).forEach(msg => {
      const time = formatTime(msg.timestamp);
      if (msg.role === 'user') {
        txt += `[${time}] You:\n${msg.content}\n\n`;
      } else {
        const agent = store.get('agents').find(a => a.id === msg.agentId);
        const name = agent ? `${agentCode(agent)} ${agent.name}` : 'Agent';
        txt += `[${time}] ${name}:\n${msg.content}\n\n`;
      }
    });

    return txt;
  }

  _download() {
    const conv = store.get('currentConversation');
    if (!conv) return;

    let content = '';
    let filename = '';
    let mimeType = 'text/plain';

    switch (this.selectedFormat) {
      case 'json':
        content = JSON.stringify(conv, null, 2);
        filename = `session_${conv.id}.json`;
        mimeType = 'application/json';
        break;
      case 'markdown':
        content = this._toMarkdown(conv);
        filename = `session_${conv.id}.md`;
        mimeType = 'text/markdown';
        break;
      case 'text':
        content = this._toText(conv);
        filename = `session_${conv.id}.txt`;
        mimeType = 'text/plain';
        break;
    }

    downloadFile(content, filename, mimeType);
    store.emit('toast', { message: `Exported as ${this.selectedFormat.toUpperCase()}`, type: 'success' });
    this.close();
  }

  close() {
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }
  }
}

export default ExportPanel;
