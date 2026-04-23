(function () {
    'use strict';

    // 允許發送帳密給擴充的來源（game-report 後台 origin）。
    const GR_ALLOWED_ORIGINS = [
        'https://report.91url.cc',
    ];

    function isAllowedOrigin(origin) {
        return GR_ALLOWED_ORIGINS.indexOf(origin) !== -1;
    }

    // 只在 game-report 自己的頁面上標記擴充已安裝，避免在無關網站留指紋
    if (isAllowedOrigin(location.origin)) {
        try {
            document.documentElement.dataset.grExtension = '1';
        } catch (e) { /* noop */ }
    }

    // 包裝 sendMessage：擴充重新載入後，舊 content script 的 chrome.runtime context 會失效，
    // 直接呼叫會丟 "Extension context invalidated"。這裡吞錯並提示使用者重新整理。
    function safeSendMessage(msg, cb) {
        try {
            chrome.runtime.sendMessage(msg, function (resp) {
                if (chrome.runtime.lastError) {
                    console.warn('[GR] sendMessage lastError:', chrome.runtime.lastError.message);
                    if (cb) cb(null);
                    return;
                }
                if (cb) cb(resp);
            });
        } catch (e) {
            if (e && String(e.message || e).indexOf('Extension context invalidated') !== -1) {
                console.warn('[GR] extension reloaded – 請 F5 重新整理此分頁');
                try { showToast('擴充已更新，請 F5 重新整理此分頁再試', true); } catch (_) { }
            } else {
                console.warn('[GR] sendMessage threw:', e);
            }
            if (cb) cb(null);
        }
    }

    // ===== 1) 從 game-report 頁面收 postMessage，轉給 background 暫存 =====
    window.addEventListener('message', function (event) {
        if (event.source !== window) return;
        if (!isAllowedOrigin(event.origin)) return;
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.source !== 'gr-provider-accounts') return;
        if (msg.type !== 'GR_PREPARE_LOGIN') return;

        safeSendMessage({ type: 'STORE_CREDS', payload: msg.payload });
    });

    // ===== 2) TOTP（Google 2FA）生成：純前端 Web Crypto + base32 =====
    function base32Decode(input) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        const cleaned = String(input).replace(/[\s=]/g, '').toUpperCase();
        if (!cleaned) throw new Error('TOTP 密鑰為空');
        let bits = 0, value = 0;
        const out = [];
        for (const ch of cleaned) {
            const v = alphabet.indexOf(ch);
            if (v < 0) throw new Error('TOTP 密鑰含非法字元：' + ch);
            value = (value << 5) | v;
            bits += 5;
            if (bits >= 8) {
                out.push((value >>> (bits - 8)) & 0xff);
                bits -= 8;
            }
        }
        return new Uint8Array(out);
    }

    async function generateTOTP(secret, digits, step) {
        digits = digits || 6;
        step = step || 30;
        const key = base32Decode(secret);
        const counter = Math.floor(Date.now() / 1000 / step);
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setUint32(0, Math.floor(counter / 0x100000000));
        view.setUint32(4, counter >>> 0);

        const cryptoKey = await crypto.subtle.importKey(
            'raw', key,
            { name: 'HMAC', hash: 'SHA-1' },
            false, ['sign']
        );
        const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, buf));
        const offset = sig[sig.length - 1] & 0x0f;
        const code = (
            ((sig[offset] & 0x7f) << 24) |
            (sig[offset + 1] << 16) |
            (sig[offset + 2] << 8) |
            sig[offset + 3]
        ) % Math.pow(10, digits);
        return code.toString().padStart(digits, '0');
    }

    // ===== 3) 剪貼簿寫入（優先 Clipboard API，失敗回退 execCommand） =====
    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.cssText = 'position:fixed;top:-9999px;opacity:0;pointer-events:none';
                (document.body || document.documentElement).appendChild(ta);
                ta.select();
                ta.setSelectionRange(0, text.length);
                const ok = document.execCommand('copy');
                ta.remove();
                return ok;
            } catch (e2) {
                console.warn('[GR] clipboard fallback failed', e2);
                return false;
            }
        }
    }

    // ===== 4) 對所有頁面：若 background 裡有本站的暫存帳密，就自動填入 + 自動複製 TOTP =====
    let retries = 0;
    const MAX_RETRIES = 10;
    // 每欄最多補填 N 次：處理 React/MUI hydration 完成後把我們填的值洗掉的情況；
    // 也避免使用者清空欄位想改填別的時被無限補回去
    const MAX_REFILLS = 5;
    const fillCounts = { user: 0, pwd: 0, code: 0 };
    let totpCopied = false; // 每個 page load 只複製一次，避免洗掉使用者剛複製的別的東西
    let consumeScheduled = false;

    function setNativeValue(el, value) {
        // 觸發 React/Vue 的 value setter，讓框架偵測到變更
        const tagProto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(tagProto, 'value');
        const setter = desc && desc.set;
        if (setter) {
            setter.call(el, value);
        } else {
            el.value = value;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // 有些框架（MUI / Ant Design）要 blur 才會 commit 驗證
        el.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const st = window.getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
    }

    const CODE_RE = /代號|代号|代理|子代|上層|上级|商戶|商户|公司|組代碼|组代码|merchant|company|corp|agent|site ?code|partner|vendor|group.?code/i;

    // 搜集 input 的可辨識文字：自身屬性 + 關聯 label + 往上走幾層找 label（處理 MUI / Element / Arco 等把 label 放在 wrapper 的框架）
    function fieldSignature(el) {
        const parts = [
            el.name || '',
            el.id || '',
            el.placeholder || '',
            el.getAttribute('aria-label') || '',
            el.getAttribute('autocomplete') || '',
            el.type || ''
        ];
        // labels 屬性（若有 <label for="id"> 會抓到）
        if (el.labels && el.labels.length) {
            for (const lbl of el.labels) parts.push(lbl.textContent || '');
        }
        // fallback：往上最多 5 層找 label
        let p = el.parentElement;
        let hops = 0;
        while (p && hops < 5) {
            const lbl = p.querySelector && p.querySelector('label');
            if (lbl) { parts.push(lbl.textContent || ''); break; }
            p = p.parentElement;
            hops++;
        }
        return parts.join(' ');
    }

    function findLoginFields() {
        const passwords = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible);
        if (passwords.length === 0) return null;
        const pwd = passwords[0];

        const all = Array.from(document.querySelectorAll('input')).filter(isVisible);
        const textTypes = new Set(['', 'text', 'email', 'tel', 'search']);

        // 帳號欄：在密碼欄之前最近一個符合的 text 類輸入
        const pwdIdx = all.indexOf(pwd);
        let userInput = null;
        for (let i = pwdIdx - 1; i >= 0; i--) {
            const t = (all[i].type || '').toLowerCase();
            if (textTypes.has(t)) { userInput = all[i]; break; }
        }
        if (!userInput) {
            for (let i = pwdIdx + 1; i < all.length; i++) {
                const t = (all[i].type || '').toLowerCase();
                if (textTypes.has(t)) { userInput = all[i]; break; }
            }
        }

        // 登錄代號欄：從屬性 + label 文字找關鍵字
        let codeInput = null;
        for (const el of all) {
            if (el === userInput || el === pwd) continue;
            const t = (el.type || '').toLowerCase();
            if (!textTypes.has(t)) continue;
            if (CODE_RE.test(fieldSignature(el))) { codeInput = el; break; }
        }

        return { userInput, pwd, codeInput };
    }

    function showToast(msg, isError) {
        const div = document.createElement('div');
        div.textContent = (isError ? '⚠ ' : '🔐 ') + msg;
        div.style.cssText = [
            'position:fixed',
            'bottom:20px',
            'right:20px',
            'background:' + (isError ? '#b91c1c' : '#1e293b'),
            'color:white',
            'padding:10px 16px',
            'border-radius:6px',
            'z-index:2147483647',
            'font-size:14px',
            'font-family:-apple-system,Segoe UI,Noto Sans TC,sans-serif',
            'box-shadow:0 4px 12px rgba(0,0,0,0.25)'
        ].join(';');
        document.documentElement.appendChild(div);
        setTimeout(function () { div.remove(); }, 3500);
    }

    function copyTotpOnce(secret) {
        if (totpCopied) return;
        totpCopied = true; // 先鎖，避免 MutationObserver 重入時重複觸發
        generateTOTP(secret).then(function (code) {
            return copyToClipboard(code).then(function (ok) {
                if (ok) {
                    showToast('2FA 驗證碼 ' + code + ' 已複製，到 2FA 頁 Ctrl+V 貼上');
                } else {
                    showToast('2FA 計算成功（' + code + '）但剪貼簿寫入失敗', true);
                }
            });
        }).catch(function (err) {
            totpCopied = false; // 還原讓下次重試
            console.warn('[GR] TOTP 計算失敗', err);
            showToast('2FA 計算失敗：' + (err && err.message || err), true);
        });
    }

    function attemptFill() {
        safeSendMessage({ type: 'GET_CREDS_FOR', url: location.href }, function (creds) {
            if (!creds) {
                // creds 還沒進 background（service worker 冷啟動 / STORE_CREDS 還在路上）→ 重試
                if (retries++ < MAX_RETRIES) setTimeout(attemptFill, 500);
                return;
            }

            const hasTotp = !!creds.totp_secret;

            // 自動複製 TOTP：只要有密鑰，每個 page load 在 content-filler 啟動時就複製一次
            // （u/p 頁與 2FA 頁都會各自算一次新 code，確保 2FA 頁按下 Ctrl+V 是當下有效的）
            if (hasTotp) copyTotpOnce(creds.totp_secret);

            const fields = findLoginFields();
            if (!fields) {
                // 沒有 password 欄（可能是獨立 2FA 頁或 SPA 還沒載好）：重試，但 TOTP 已經複製了
                if (retries++ < MAX_RETRIES) setTimeout(attemptFill, 500);
                return;
            }

            const { userInput, pwd, codeInput } = fields;
            const filledHere = [];

            // 每欄的填入判斷：當下值為空 + 還沒用完補填次數。
            // React/MUI 常見現象：DOM 已出現我們也 setNativeValue 完成，但 hydration 晚於我們執行，
            // React 拿 state（空字串）把 DOM 值又洗掉 → 下一輪 MutationObserver 進來 el.value 又是空的，再補一次。
            // 用 MAX_REFILLS 擋掉「使用者故意清空想重填」被無限覆蓋的情況。
            function needFill(el, count) {
                return el && !el.value && count < MAX_REFILLS;
            }

            if (needFill(userInput, fillCounts.user) && creds.username) {
                setNativeValue(userInput, creds.username);
                fillCounts.user++;
                filledHere.push('帳號');
            }
            if (needFill(pwd, fillCounts.pwd) && creds.password) {
                setNativeValue(pwd, creds.password);
                fillCounts.pwd++;
                filledHere.push('密碼');
            }
            if (needFill(codeInput, fillCounts.code) && creds.login_code) {
                setNativeValue(codeInput, creds.login_code);
                fillCounts.code++;
                filledHere.push('登錄代號');
            }

            if (filledHere.length === 0) return;

            // 消耗策略：
            // - 有 TOTP → 留著讓 2FA 頁 content-filler 能再算 code（5 分鐘 TTL 收尾）
            // - 沒 TOTP → 延遲 3 秒才消耗，讓 React hydration 洗值時我們還能補填
            if (!hasTotp && !consumeScheduled) {
                consumeScheduled = true;
                setTimeout(function () {
                    safeSendMessage({ type: 'CONSUME_CREDS_FOR', url: location.href });
                }, 3000);
            }

            // 提示訊息：TOTP 已另外獨立 toast，這裡只提 text 欄位
            showToast('已自動填入 ' + filledHere.join('、') + '，請確認後點登入');
        });
    }

    function start() {
        attemptFill();
        // 針對 SPA / 非同步出現的表單：監聽 DOM 變化
        const mo = new MutationObserver(function () {
            attemptFill();
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
        // 安全保險：60 秒後停止觀察
        setTimeout(function () { mo.disconnect(); }, 60000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
