/*
 * Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
 *
 * Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
 *
 * BryceFromIndiana@gmail.com
 */

// ============================================
// THEMES.JS — Theme manager
// ============================================

import { store } from './store.js?v=358';
import { K } from './storage.js?v=358';

const THEMES = ['dark', 'matrix', 'cyberpunk'];

const THEME_LABELS = {
  dark: 'Dark',
  matrix: 'Matrix',
  cyberpunk: 'Cyberpunk',
};

class ThemeManager {
  constructor() {
    this.current = store.get('settings.theme') || 'dark';
    this.apply(this.current);
  }

  apply(theme) {
    if (!THEMES.includes(theme)) theme = 'dark';
    this.current = theme;
    // base.css targets body.matrix / body.cyberpunk as CLASSES. Setting a
    // data-theme attribute matched nothing, so the picker looked like it saved
    // and the colours never moved. Set the class (and keep the attribute as a
    // hook for anything else that wants to read it).
    document.body.classList.remove(...THEMES);
    if (theme !== 'dark') document.body.classList.add(theme);
    document.body.setAttribute('data-theme', theme);
    store.set('settings.theme', theme);
    localStorage.setItem(K.THEME, theme);
  }

  toggle() {
    const idx = THEMES.indexOf(this.current);
    const next = THEMES[(idx + 1) % THEMES.length];
    this.apply(next);
    return next;
  }

  next() {
    const idx = THEMES.indexOf(this.current);
    const next = THEMES[(idx + 1) % THEMES.length];
    this.apply(next);
    return next;
  }

  getThemes() {
    return THEMES;
  }

  getThemeLabel(theme) {
    return THEME_LABELS[theme] || theme;
  }

  getCurrent() {
    return this.current;
  }
}

// Singleton instance
export const themeManager = new ThemeManager();
export default themeManager;
