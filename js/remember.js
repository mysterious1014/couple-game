// 「记住账号密码」的本地存取。只往本机 localStorage 写一份可回填的凭据。
//
// ⚠️ 诚实说明：这里的 encode/decode 是**混淆，不是加密**。密钥就写死在本文件里，
//    任何能在页面执行脚本的人（XSS、DevTools）都能还原，它只挡两件事：
//      ① 打开 localStorage 面板时直接看到明文；② 共享机器上的肉眼瞥见。
//    真正让她「打开网站就是登录状态」的是服务端会话 Cookie（/api/login 的 remember），
//    那个不依赖本地存密码。所以这个开关不勾，也只是下次要重新打一次密码而已。
//
// 本模块刻意不碰 DOM，storage 由调用方注入，方便在 Node 里直接单测。

const OBFUSCATE_KEY = 'cg-remember-v1';
export const REMEMBER_KEY = 'cg_auth_remember';
export const USERNAME_KEY = 'cg_username';        // 沿用旧键，兼容既有行为
export const RECORD_VERSION = 1;

function xorBytes(bytes, keyText) {
  const key = new TextEncoder().encode(keyText);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key[i % key.length];
  return out;
}

export function encodeSecret(text, keyText = OBFUSCATE_KEY) {
  const mixed = xorBytes(new TextEncoder().encode(String(text)), keyText);
  let binary = '';
  for (const byte of mixed) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeSecret(blob, keyText = OBFUSCATE_KEY) {
  const binary = atob(String(blob));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(xorBytes(bytes, keyText));
}

// localStorage 在隐私模式 / 禁用 Cookie 时会抛异常，兜一个纯内存的实现
function memoryStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function resolveStorage(injected) {
  if (injected) return injected;
  try {
    const probe = '__cg_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return memoryStore();
  }
}

export function createRemember(storage) {
  const store = resolveStorage(storage);
  const safeGet = (k) => { try { return store.getItem(k); } catch { return null; } };
  const safeSet = (k, v) => { try { store.setItem(k, v); return true; } catch { return false; } };
  const safeRemove = (k) => { try { store.removeItem(k); } catch { /* 忽略 */ } };

  return {
    // 只记用户名（登录成功后总会调用，跟改动前的行为一致）
    saveUsername(username) { safeSet(USERNAME_KEY, String(username || '')); },
    loadUsername() { return safeGet(USERNAME_KEY) || ''; },

    // 记用户名 + 密码
    save(username, password) {
      this.saveUsername(username);
      const payload = JSON.stringify({
        v: RECORD_VERSION, u: String(username || ''), p: encodeSecret(password || ''),
      });
      return safeSet(REMEMBER_KEY, payload);
    },

    // 读回凭据；没记 / 数据坏了 / 版本不对都当「没记」处理，绝不让登录框炸掉
    load() {
      const raw = safeGet(REMEMBER_KEY);
      if (!raw) return null;
      try {
        const rec = JSON.parse(raw);
        if (!rec || rec.v !== RECORD_VERSION || typeof rec.u !== 'string' || typeof rec.p !== 'string') return null;
        return { username: rec.u, password: decodeSecret(rec.p) };
      } catch {
        this.clear();
        return null;
      }
    },

    // 只抹掉密码，用户名留着方便下次回填
    clear() { safeRemove(REMEMBER_KEY); },
    isRemembered() { return !!this.load(); },
  };
}

export const Remember = createRemember();