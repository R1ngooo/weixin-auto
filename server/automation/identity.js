import { sha256, truncate } from '../util.js';

const NICK_KEYS = ['nickname', 'nickName', 'nick_name', 'nick', 'displayName', 'display_name', 'name'];
const AVATAR_KEYS = ['headimgurl', 'headImgUrl', 'head_img_url', 'avatar', 'avatarUrl', 'avatar_url', 'headUrl', 'head_url', 'headimg'];
const WXID_KEYS = ['wxid', 'wxId', 'userName', 'username', 'user_name', 'userid', 'userId', 'uid', 'openid', 'openId', 'unionid'];
const FINDER_USERNAME_KEYS = ['finderUsername', 'finder_username', 'finderUserName', 'username', 'uniqId', 'uniq_id'];
const UIN_KEYS = ['uin', 'fakeUin', 'fake_uin', 'wxuin', 'wxUin'];

function pickDeep(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = pickDeep(item, keys, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of keys) {
    const v = value[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  for (const v of Object.values(value)) {
    if (v && typeof v === 'object') {
      const hit = pickDeep(v, keys, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function parseCookies(raw) {
  const out = {};
  for (const part of String(raw || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

/** 解析页面内 fetch 得到的账号信息（auth_data / auth_wx），结果尽量宽容 */
export function parseIdentity({ authData, wxInfo, cookieText, dom }) {
  const authPayload = authData && typeof authData === 'object'
    ? (authData.data && typeof authData.data === 'object' ? { ...authData, ...authData.data } : authData)
    : null;
  const finder = authPayload?.finder || authPayload?.data?.finder || null;
  const finderList = authPayload?.finderList || authPayload?.data?.finderList || null;
  const cookies = parseCookies(cookieText);

  const wechatNickname = pickDeep(wxInfo, NICK_KEYS) || pickDeep(authPayload, ['mpLoginNickname', 'wxNickname', 'wx_nickname'])
    || pickDeep(authPayload?.displayFeedContact, NICK_KEYS);
  const avatarUrl = pickDeep(wxInfo, AVATAR_KEYS) || pickDeep(authPayload?.displayFeedContact, AVATAR_KEYS);
  const wechatId = pickDeep(wxInfo, WXID_KEYS);
  const finderNickname = pickDeep(finder, NICK_KEYS) || pickDeep(authPayload, ['finderNickname', 'nickname']);
  const finderUsername = pickDeep(finder, FINDER_USERNAME_KEYS);
  const uin = pickDeep(authPayload, UIN_KEYS) || cookies.wxuin || cookies.uin || null;

  const raw = {
    authErrCode: authData?.errCode ?? null,
    wxErrCode: wxInfo?.errCode ?? null,
    finderCount: Array.isArray(finderList) ? finderList.length : null,
    cookieKeys: Object.keys(cookies),
  };

  let identityKey = null;
  let identityType = null;
  if (wechatId) { identityKey = `wxid:${wechatId}`; identityType = '微信ID'; }
  else if (uin) { identityKey = `uin:${uin}`; identityType = '微信UIN'; }
  else if (finderUsername) { identityKey = `finder:${finderUsername}`; identityType = '视频号ID'; }
  else if (wechatNickname || finderNickname) {
    identityKey = `name:${sha256(`${wechatNickname || ''}|${finderNickname || ''}|${avatarUrl || ''}`).slice(0, 20)}`;
    identityType = '昵称指纹';
  }

  return {
    wechatId: wechatId || null,
    wechatNickname: wechatNickname || null,
    avatarUrl: avatarUrl || null,
    finderUsername: finderUsername || null,
    finderNickname: finderNickname || null,
    uin: uin ? String(uin) : null,
    identityKey,
    identityType,
    name: wechatNickname || finderNickname || (dom?.title ? truncate(dom.title, 24) : null),
    displayName: finderNickname || wechatNickname || null,
    raw,
  };
}

/** 在页面里读取账号信息（带 Cookie，走站点自身接口） */
export async function readPageIdentity(page, selectors) {
  const apiBase = selectors?.platform?.apiBase || '/cgi-bin/mmfinderassistant-bin';
  const evaluated = await page.evaluate(async ({ base, authPath, wxPath }) => {
    const post = async (pathname) => {
      try {
        const res = await fetch(base + pathname, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: '{}',
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, json, text: text.slice(0, 4000) };
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) };
      }
    };
    const auth = await post(authPath);
    const wx = await post(wxPath);
    return {
      authData: auth.json,
      authText: auth.json ? null : auth.text,
      wxInfo: wx.json,
      wxText: wx.json ? null : wx.text,
      cookieText: document.cookie,
      title: document.title,
      href: location.href,
    };
  }, { base: apiBase, authPath: selectors?.platform?.authDataPath || '/auth/auth_data', wxPath: selectors?.platform?.wxInfoPath || '/auth/auth_wx' }).catch((error) => ({
    error: String(error?.message || error),
    cookieText: '',
  }));

  if (evaluated.error) {
    return { identity: null, diagnostic: evaluated };
  }

  const domIdentity = await page.evaluate((selectors) => {
    const pick = (list) => {
      for (const selector of list || []) {
        const el = document.querySelector(selector);
        if (el) {
          const text = (el.textContent || '').trim();
          const img = el.querySelector?.('img') || (el.tagName === 'IMG' ? el : null);
          if (text) return { text, img: img?.src || null };
        }
      }
      return null;
    };
    return {
      name: pick(selectors?.platform?.accountNameSelectors),
      avatar: pick(selectors?.platform?.accountAvatarSelectors),
    };
  }, selectors).catch(() => null);

  const identity = parseIdentity({
    authData: evaluated.authData,
    wxInfo: evaluated.wxInfo,
    cookieText: evaluated.cookieText || '',
    dom: { title: evaluated.title, name: domIdentity?.name?.text, avatar: domIdentity?.avatar?.img },
  });

  if (!identity.avatarUrl && domIdentity?.avatar?.img) identity.avatarUrl = domIdentity.avatar.img;
  if (!identity.wechatNickname && domIdentity?.name?.text && !identity.finderNickname) {
    identity.wechatNickname = domIdentity.name.text;
    if (!identity.name) identity.name = domIdentity.name.text;
  }

  return {
    identity,
    diagnostic: {
      href: evaluated.href,
      authErrCode: evaluated.authData?.errCode ?? null,
      authText: evaluated.authText,
      wxErrCode: evaluated.wxInfo?.errCode ?? null,
      wxText: evaluated.wxText,
      parsed: identity.raw,
    },
  };
}

export function isLoginUrl(url, selectors) {
  const pattern = selectors?.platform?.loginUrlPattern || 'login.html';
  return String(url || '').includes(pattern);
}

export function isPlatformUrl(url) {
  return /channels\.weixin\.qq\.com\/platform/.test(String(url || ''));
}
