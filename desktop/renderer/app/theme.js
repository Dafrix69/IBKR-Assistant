'use strict';
// 外观(夜间模式、涨跌配色)

// ======================================================================
// 外观(夜间模式):走主进程 nativeTheme,渲染层 prefers-color-scheme 一起切
// ======================================================================
/** 涨跌配色是显示偏好,不是引擎配置:记在本地,只改 :root 的 data-updown,token 映射随之翻转。 */
function applyUpDown(mode) {
  const value = mode === 'red-up' ? 'red-up' : 'green-up';
  document.documentElement.dataset.updown = value;
  try { localStorage.setItem('dafri-updown', value); } catch { /* 预览台的 data: 页面没有 localStorage */ }
  document.querySelectorAll('#updown-picker [data-updown]').forEach((btn) =>
    btn.classList.toggle('active', btn.dataset.updown === value)
  );
  // 已经画在屏幕上的图不会自己变色,能重画的当场重画
  if (typeof renderPa === 'function' && pa.data) renderPa();
  if (typeof renderReview === 'function' && review.data) renderReview();
}

async function applyTheme(mode) {
  try {
    await window.dafri.setTheme(mode);
  } catch (err) {
    showBanner(`切换外观失败:${err.message}`, false);
    return;
  }
  localStorage.setItem('dafri-theme', mode);
  document.querySelectorAll('#theme-picker [data-theme-mode]').forEach((btn) =>
    btn.classList.toggle('active', btn.dataset.themeMode === mode)
  );
}
