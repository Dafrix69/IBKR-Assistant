'use strict';
/**
 * 新版本检查:只读 GitHub Releases 的公开信息,告诉用户"有新版了、去哪下"。不下载、不安装、不替换任何文件。
 *
 * 为什么不是 electron-updater 那种自动安装:macOS 的自动更新(Squirrel.Mac)要求新旧两版都带同一个
 * Developer ID 签名,ad-hoc 包装不上;Windows 包也没签名。在证书到手之前,"提示 + 一键打开下载页"
 * 是两个平台都成立的最大公约数。证书到手后换成自动安装,这个模块的版本比较与资产挑选照样用得上。
 *
 * 安全口径:
 *   * 只在主进程里发请求(渲染层的 CSP 是 connect-src 'none',不为它开口子);
 *   * 返回给界面的链接只认本仓库 releases 下的地址,其余一律丢掉换成固定的下载页——
 *     响应被篡改也只能把人带到我们自己的发布页;
 *   * 发布说明按纯文本截断后交出去,界面当文本显示,不当 HTML。
 *
 * electron 不在这里 require:fetch 由调用方注入(主进程给 net.fetch),测试在纯 Node 里给假的。
 */

const RELEASES_REPO = 'Dafrix69/IBKR-Assistant';
const LATEST_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases/`;
const DOWNLOAD_PREFIX = `${RELEASES_PAGE}download/`;
const NOTES_MAX = 1200;
const TIMEOUT_MS = 8000;

/** 'v0.5.2' / '0.5.2-beta.1' → { nums: [0,5,2], pre: 'beta.1' };认不出的返回 null(认不出就不提示,不瞎比)。 */
function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text || '').trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' };
}

/** 预发布段按 semver 比:逐段,数字段按数值、比字母段小;段数少的小。 */
function comparePre(a, b) {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb) {
      const d = Number(pa[i]) - Number(pb[i]);
      if (d !== 0) return Math.sign(d);
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/** a < b → -1,相等 → 0,a > b → 1;任一边认不出 → null。正式版比同号的预发布版新(0.6.0 > 0.6.0-beta.2)。 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (va.nums[i] !== vb.nums[i]) return va.nums[i] < vb.nums[i] ? -1 : 1;
  }
  if (va.pre === vb.pre) return 0;
  if (!va.pre) return 1;
  if (!vb.pre) return -1;
  return comparePre(va.pre, vb.pre);
}

/**
 * 这台机器该下哪个安装包。命名见 desktop/package.json 的 artifactName:
 * IBKR-Assistant-<版本>-mac-arm64.dmg / IBKR-Assistant-<版本>-win-x64.exe。
 * .blockmap、latest.yml 之类的附带文件不算。找不到(比如 Intel Mac 没有对应的包)就返回 null,界面只给下载页。
 */
function assetFor(assets, platform, arch) {
  const plat = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : null;
  const ext = platform === 'darwin' ? 'dmg' : 'exe';
  if (!plat || !Array.isArray(assets)) return null;
  const tail = `-${plat}-${arch}.${ext}`;
  const hit = assets.find((a) => a && typeof a.name === 'string' && a.name.endsWith(tail));
  if (!hit || typeof hit.browser_download_url !== 'string' || !hit.browser_download_url.startsWith(DOWNLOAD_PREFIX)) {
    return null;
  }
  return {
    name: hit.name,
    url: hit.browser_download_url,
    size: Number.isFinite(hit.size) ? hit.size : null,
  };
}

/** 发布说明:只要纯文本,去掉 Markdown 里最吵的几样,截断。 */
function plainNotes(body) {
  const text = String(body || '')
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > NOTES_MAX ? `${text.slice(0, NOTES_MAX).trimEnd()}…` : text;
}

/** GitHub 的一条 release → 界面要的那几项。纯函数,单测直接喂 JSON。 */
function summarizeRelease(release, { current, platform, arch, now = Date.now() }) {
  const tag = String(release?.tag_name || '');
  const latest = tag.replace(/^v/, '');
  const cmp = compareVersions(current, latest);
  const page = typeof release?.html_url === 'string' && release.html_url.startsWith(RELEASES_PAGE)
    ? release.html_url
    : `${RELEASES_PAGE}latest`;
  const asset = assetFor(release?.assets, platform, arch);
  return {
    current: String(current),
    latest: latest || null,
    // 认不出版本号(cmp 为 null)按"没有新版"处理:宁可少提示一次,也不拿一个比不出来的号去催人升级
    newer: cmp === -1,
    url: page,
    download: asset,
    publishedAt: typeof release?.published_at === 'string' ? release.published_at : null,
    notes: plainNotes(release?.body),
    checkedAt: now,
  };
}

/**
 * 查一次最新正式版。/releases/latest 本来就不含草稿与预发布版。
 * 失败抛 Error,message 是给人看的中文——检查更新失败不该有任何别的后果。
 */
async function checkForUpdate({ current, platform, arch, fetchImpl, timeoutMs = TIMEOUT_MS, now }) {
  if (typeof fetchImpl !== 'function') throw new Error('检查更新不可用');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(LATEST_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub 的 API 不带 User-Agent 直接 403;只报应用名与版本,不带任何账户或机器信息
        'User-Agent': `IBKR-Assistant/${current}`,
      },
      signal: ctrl.signal,
    });
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || ctrl.signal.aborted);
    throw new Error(aborted ? '连接 GitHub 超时,稍后再试(不影响交易)' : '连不上 GitHub,稍后再试(不影响交易)', { cause: err });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) throw new Error('还没有发布过正式版本');
  if (res.status === 403 || res.status === 429) throw new Error('GitHub 限制了查询频率,过一小时再试');
  if (!res.ok) throw new Error(`检查更新失败(HTTP ${res.status})`);
  let release;
  try {
    release = await res.json();
  } catch (err) {
    throw new Error('GitHub 返回的内容读不懂,稍后再试', { cause: err });
  }
  return summarizeRelease(release, { current, platform, arch, now });
}

module.exports = {
  RELEASES_REPO,
  RELEASES_PAGE,
  LATEST_API,
  parseVersion,
  compareVersions,
  assetFor,
  plainNotes,
  summarizeRelease,
  checkForUpdate,
};
