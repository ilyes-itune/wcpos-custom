import * as path from 'path';
import { BrowserWindow, shell } from 'electron';
import serve from 'electron-serve';
import { logger as log } from './log';
import { isDevelopment } from './util';

let loadURL: (window: BrowserWindow) => void;

if (isDevelopment) {
    const expoPort = process.env.EXPO_PORT || '8088';
    loadURL = (window: BrowserWindow) => window.loadURL(`http://localhost:${expoPort}`);
} else {
    const pathToDist = path.join(process.resourcesPath, 'dist');
    loadURL = serve({ directory: pathToDist, scheme: 'wcpos' });
}

let mainWindow: BrowserWindow | null;

const APP_VERSION  = 'WCPOS Custom 5.5';
const WP_SITE_URL  = 'https://usmm-tir.fr';
const WP_REST_BASE = 'https://usmm-tir.fr/wp-json/wcpos-custom/v1';

const PANEL_TEXTS: Record<string, string> = {
    products:  'Ajustez les prix et quantités',
    orders:    'Rouvrez et imprimez les reçus',
    customers: 'Ajoutez de nouveaux clients',
    reports:   'Débloquez les rapports',
};

function tabFromUrl(url: string): string | null {
    try {
        const segments = new URL(url).pathname.replace(/\/+$/, '').split('/').filter(Boolean);
        const last = segments[segments.length - 1]?.toLowerCase() ?? '';
        return ['products', 'orders', 'customers', 'reports'].includes(last) ? last : null;
    } catch { return null; }
}

export const createWindow = (): void => {
    mainWindow = new BrowserWindow({
        show: false, width: 1024, height: 728, title: APP_VERSION,
        icon: path.join(__dirname, '../../icons/icon.ico'),
        webPreferences: {
            preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
            sandbox: false, nodeIntegration: false, contextIsolation: true,
        },
        backgroundColor: '#fff',
    });

    if (isDevelopment) mainWindow.webContents.openDevTools();

    /* ── Logging renderer ────────────────────────────────────────────────── */
    mainWindow.webContents.on('console-message', (_e, level, message, line, src) => {
        const short = (src ?? '').split('/').pop() ?? '';
        const tag   = `[R ${short}:${line}]`;
        if      (level === 3) log.error(`${tag} ${message}`);
        else if (level === 2) log.warn (`${tag} ${message}`);
        else                  log.info (`${tag} ${message}`);

        if (message.startsWith('[resize] recalcul pid=')) {
            const pid = message.replace('[resize] recalcul pid=', '').trim();
            setTimeout(() => runPanelForTab(pid || lastTab), 400);
        }
        if (message.startsWith('[wcpos-nav-to] ')) {
            const target = message.replace('[wcpos-nav-to] ', '').trim();
            log.info(`[nav-to] → ${target}`);
            if (!mainWindow || mainWindow.isDestroyed()) return;
            try {
                const cur    = mainWindow.webContents.getURL();
                const parsed = new URL(cur);
                const segs   = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
                if (segs.length > 0) segs[segs.length - 1] = target;
                else segs.push(target);
                const newUrl = parsed.origin + '/' + segs.join('/');
                log.info(`[nav-to] ${cur} → ${newUrl}`);
                lastTab = null;
                mainWindow.webContents.loadURL(newUrl);
            } catch (e) { log.error(`[nav-to] ${e}`); }
        }
    });

    mainWindow.webContents.on('render-process-gone', (_e, d) =>
        log.error(`[renderer-gone] reason=${d.reason} exit=${d.exitCode}`));
    mainWindow.webContents.on('unresponsive', () => log.error('[renderer] UNRESPONSIVE'));
    mainWindow.webContents.on('responsive',   () => log.info ('[renderer] responsive'));

    /* ── Blocage réseau ──────────────────────────────────────────────────── */
    mainWindow.webContents.session.webRequest.onBeforeRequest(
        { urls: ['*://*.novu.co/*','*://novu.co/*','*://updates.wcpos.com/*',
                 '*://wcpos.com/*','*://*.wcpos.com/*','*://api.github.com/repos/wcpos/*'] },
        (_d, cb) => cb({ cancel: true })
    );
    mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
        { urls: [WP_SITE_URL + '/*'] },
        (d, cb) => cb({ requestHeaders: { ...d.requestHeaders, Origin: 'wcpos://-' } })
    );
    mainWindow.webContents.session.webRequest.onHeadersReceived(
        { urls: [WP_SITE_URL + '/*'] },
        (d, cb) => {
            const h: Record<string, string[]> = {};
            for (const [k, v] of Object.entries(d.responseHeaders ?? {})) {
                if (!['access-control-allow-origin','access-control-allow-credentials',
                      'access-control-allow-methods','access-control-allow-headers',
                      'x-content-type-options'].includes(k.toLowerCase()))
                    h[k] = v as string[];
            }
            h['Access-Control-Allow-Origin']      = ['wcpos://-'];
            h['Access-Control-Allow-Credentials'] = ['true'];
            h['Access-Control-Allow-Methods']     = ['GET, POST, OPTIONS'];
            h['Access-Control-Allow-Headers']     = ['Content-Type, Authorization'];
            cb({ responseHeaders: h });
        }
    );

    loadURL(mainWindow);
    mainWindow.on('page-title-updated', e => {
        e.preventDefault();
        mainWindow?.setTitle(APP_VERSION);
    });

    /* ════════════════════════════════════════════════════════════════════════
       BLOC 1 — Anti-pub
       ════════════════════════════════════════════════════════════════════════ */
    function runAntiPro(): void {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const HIDE = ['upgrade-notice-banner','upgrade-title','upgrade-to-pro-button',
                      'view-demo-button','add-fee','add-shipping'];
        const css = HIDE.map(t => `[data-testid='${t}']`).join(',')
            + `,[aria-label='Notifications'],[aria-label='Open notification center']{display:none!important}`;
        mainWindow.webContents.executeJavaScript(`(function(){
            if(window.__ap||!document||!document.documentElement)return;
            window.__ap=true;
            var s=document.createElement('style');s.id='wcpos-ap';
            s.textContent=${JSON.stringify(css)};
            (document.head||document.documentElement).appendChild(s);
            console.log('[ap] OK');
        })();`).catch((e: Error) => log.error('[ap] ' + e.message));
    }

    /* ════════════════════════════════════════════════════════════════════════
       BLOC 2 — Setup : overlay infrastructure
       Définit window.__showOverlay / __hideOverlay / __overlayIsVisible
       et window.__loadPanel.
       ════════════════════════════════════════════════════════════════════════ */
    function runSetup(): void {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.executeJavaScript(`(function(){
            if(window.__setup||!document||!document.body)return;
            if(!document.querySelector('[data-testid="search-products"]')){
                console.log('[setup] hors POS'); return;
            }
            window.__setup=true;
            var REST=${JSON.stringify(WP_REST_BASE)};
            window._wcposRestBase=REST;

            /* Overlay #wco */
            window.__showOverlay=function(msg){
                var ov=document.getElementById('wco');
                if(!ov){
                    ov=document.createElement('div');ov.id='wco';
                    ov.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(20,42,65,.97);'
                        +'display:none;flex-direction:column;align-items:center;justify-content:center;'
                        +'text-align:center;padding:24px;font-family:sans-serif;color:#fff;';
                    ov.innerHTML='<div style="font-size:3em;margin-bottom:14px">&#128274;</div>'
                        +'<h2 style="font-size:1.2em;font-weight:700;margin:0 0 10px">Caisse ferm\u00e9e</h2>'
                        +'<p id="wco-msg" style="font-size:.9em;opacity:.8;max-width:340px;line-height:1.5;margin:0 0 20px">'
                        +(msg||"La caisse n'est pas ouverte.")+'</p>'
                        +'<button id="wco-btn" style="background:#00a32a;color:#fff;border:none;'
                        +'padding:10px 24px;border-radius:6px;font-size:.95em;font-weight:600;cursor:pointer">'
                        +'&#128194; Ouvrir la caisse</button>';
                    document.body.appendChild(ov);
                    document.getElementById('wco-btn').addEventListener('click',function(){
                        ov.style.display='none';
                        console.log('[wcpos-nav-to] customers');
                    });
                    console.log('[setup] overlay DOM cr\u00e9\u00e9');
                }
                if(msg){var p=document.getElementById('wco-msg');if(p)p.textContent=msg;}
                ov.style.display='flex';
                console.log('[setup] overlay affich\u00e9');
            };
            window.__hideOverlay=function(){
                var ov=document.getElementById('wco');
                if(ov)ov.style.setProperty('display','none','important');
            };
            window.__overlayIsVisible=function(){
                var ov=document.getElementById('wco');return ov?ov.style.display!=='none':false;
            };

            /* Panel loader */
            window.__loadPanel=function(pid,wrap,cv,force){
                if(window.__loadingPanel&&!force)return;
                window.__loadingPanel=true;
                wrap.innerHTML='<p style="padding:20px;color:#646970;font-family:sans-serif">Chargement\u2026</p>';
                var url=REST+'/panel/'+pid+(cv?'?caisse_view='+encodeURIComponent(cv):'');
                fetch(url,{method:'GET',credentials:'include'})
                .then(function(r){return r.ok?r.json():Promise.reject(new Error('HTTP '+r.status));})
                .then(function(d){
                    window.__loadingPanel=false;
                    if(!d||!d.html){wrap.innerHTML='<p style="padding:20px;color:#856404">Snippet wcpos_panel_'+pid+' inactif dans WPCode.</p>';return;}
                    wrap.innerHTML=d.html;
                    wrap.querySelectorAll('script').forEach(function(s){var ns=document.createElement('script');ns.textContent=s.textContent;s.parentNode.replaceChild(ns,s);});
                })
                .catch(function(e){window.__loadingPanel=false;wrap.innerHTML='<p style="padding:20px;color:#c00">'+e.message+'</p>';});
            };

            /* Action queue (submit caisse depuis le panel) */
            window._wcpos_action=null;
            setInterval(function(){
                if(!window._wcpos_action)return;
                var a=window._wcpos_action;window._wcpos_action=null;
                var wpp=document.getElementById('wpp');
                if(a.type==='nav'&&wpp){window.__loadingPanel=false;window.__loadPanel(wpp.getAttribute('data-pid'),wpp,a.view,true);}
            },200);

            /* Resize */
            if(!window.__wcpos_resize){
                window.__wcpos_resize=true;
                var _rt=null;
                window.addEventListener('resize',function(){
                    clearTimeout(_rt);
                    _rt=setTimeout(function(){var w=document.getElementById('wpp');if(w){w.remove();console.log('[resize] recalcul pid='+w.getAttribute('data-pid'));}},400);
                });
            }
            console.log('[setup] v5.2 OK');
        })();`).catch((e: Error) => log.error('[setup] ' + e.message));
    }

    /* ════════════════════════════════════════════════════════════════════════
       BLOC 3 — WCPOS Custom
       Auth + overlay caisse + panel injection + toast admin
       Tout ce qui était dans wcpos-custom.php section 4 tourne ici
       car la page POS est servie depuis dist/ (scheme wcpos://), pas PHP.
       ════════════════════════════════════════════════════════════════════════ */
    function runWcposCustom(): void {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.executeJavaScript(`(function(){
            if(window.__wcposCustom||!document||!document.body)return;
            if(!document.querySelector('[data-testid="search-products"]')){
                console.log('[custom] hors POS'); return;
            }
            window.__wcposCustom=true;
            console.log('[custom] v5.2 init');

            var REST=${JSON.stringify(WP_REST_BASE)};
            var PANEL_TEXTS=${JSON.stringify(PANEL_TEXTS)};
            window._wcposRestBase=REST;

            /* CSS anti-pub inline */
            if(!document.getElementById('wcpos-ap2')){
                var s=document.createElement('style');s.id='wcpos-ap2';
                s.textContent='[data-testid="upgrade-notice-banner"],[data-testid="upgrade-title"],'
                    +'[data-testid="upgrade-to-pro-button"],[data-testid="view-demo-button"],'
                    +'[data-testid="add-fee"],[data-testid="add-shipping"]{display:none!important}'
                    +'#wcpos-panel-content{width:100%;height:100%;display:block;overflow:auto;'
                    +'background:#f6f7f7;padding:20px 24px;font-family:-apple-system,sans-serif;'
                    +'font-size:14px;color:#1d2327;box-sizing:border-box}';
                (document.head||document.documentElement).appendChild(s);
            }

            /* ── Helpers ── */
            function currentTab(){
                var u=(window.location.href||'').toLowerCase();
                var tabs=['products','orders','customers','reports'];
                for(var i=0;i<tabs.length;i++){if(u.indexOf(tabs[i])!==-1)return tabs[i];}
                return null;
            }

            /* ── Auth (whoami) ── */
            window.wcposAuth=(function(){
                var _login='',_canEdit=false,_ready=false,_cbs=[],_tries=0;
                function getUserFromDOM(){
                    var els=document.querySelectorAll('[class*="whitespace-nowrap"]');
                    for(var i=0;i<els.length;i++){
                        var el=els[i],txt=(el.textContent||'').trim();
                        if(el.children.length===0&&txt.length>=2&&txt.length<=40&&/^[a-zA-ZÀ-ÿ]/.test(txt))return txt.toLowerCase();
                    }
                    return '';
                }
                function fire(){_ready=true;console.log('[custom] auth ready canEdit='+_canEdit);_cbs.forEach(function(cb){cb(_canEdit);});_cbs=[];}
                function init(){
                    _tries++;
                    var dl=getUserFromDOM();
                    if(!dl){if(_tries>=20){console.warn('[custom] getUserFromDOM timeout, canEdit=false');fire();}else setTimeout(init,500);return;}
                    fetch(REST+'/whoami',{method:'POST',body:JSON.stringify({client_login:dl}),headers:{'Content-Type':'application/json'},credentials:'include'})
                    .then(function(r){return r.json();})
                    .then(function(d){_login=d.login||dl;_canEdit=!!d.can_edit;fire();})
                    .catch(function(e){console.warn('[custom] whoami erreur:',e.message);fire();});
                }
                return{init:init,canEdit:function(){return _canEdit;},login:function(){return _login;},onReady:function(cb){if(_ready)cb(_canEdit);else _cbs.push(cb);}};
            })();
            window.wcposAuth.init();

            /* ── Masquage Pro ── */
            var HIDE=['upgrade-notice-banner','upgrade-title','upgrade-to-pro-button','view-demo-button','add-fee','add-shipping'];
            function hideProElements(){
                HIDE.forEach(function(t){document.querySelectorAll('[data-testid="'+t+'"]').forEach(function(el){el.style.setProperty('display','none','important');});});
            }

            /* ── Panel injection ── */
            function loadPanel(pid,wrap,cv){
                if(window.__loadPanel){window.__loadPanel(pid,wrap,cv,true);return;}
                wrap.innerHTML='<p style="padding:20px;color:#646970">Chargement\u2026</p>';
                var url=REST+'/panel/'+pid+(cv?'?caisse_view='+encodeURIComponent(cv):'');
                fetch(url,{method:'GET',credentials:'include'})
                .then(function(r){return r.ok?r.json():Promise.reject(new Error('HTTP '+r.status));})
                .then(function(d){
                    if(!d||!d.html){wrap.innerHTML='<p style="padding:20px;color:#856404">Snippet wcpos_panel_'+pid+' inactif dans WPCode.</p>';return;}
                    wrap.innerHTML=d.html;
                    wrap.querySelectorAll('script').forEach(function(s){var ns=document.createElement('script');ns.textContent=s.textContent;s.parentNode.replaceChild(ns,s);});
                })
                .catch(function(e){wrap.innerHTML='<p style="padding:20px;color:#c00">'+e.message+'</p>';});
            }

            function findProPanel(){
                var all=document.querySelectorAll('div'),best=null,bH=Infinity;
                for(var i=0;i<all.length;i++){
                    var el=all[i],r=el.getBoundingClientRect();
                    if(r.width<300||r.height<80||r.x>400||r.width>window.innerWidth*0.95)continue;
                    var text=el.textContent||'';
                    for(var pid in PANEL_TEXTS){if(text.indexOf(PANEL_TEXTS[pid])!==-1&&r.height<bH){bH=r.height;best={el:el,panelId:pid};}}
                }
                return best;
            }

            var injecting=false;
            function injectPanel(){
                if(injecting)return;
                var found=findProPanel();if(!found)return;
                var el=found.el,pid=found.panelId;
                if(pid==='customers'){
                    if(!document.getElementById('wcpos-panel-content')){
                        injecting=true;el.innerHTML='';el.style.cssText='display:flex;flex-direction:column;flex:1;padding:0;overflow:hidden;';
                        var w=document.createElement('div');w.id='wcpos-panel-content';w.setAttribute('data-panel','customers');el.appendChild(w);loadPanel('customers',w,null);injecting=false;
                    }
                    return;
                }
                var ex=el.querySelector('#wcpos-panel-content');
                if(ex&&ex.getAttribute('data-panel')===pid)return;
                if(ex){ex.setAttribute('data-panel',pid);loadPanel(pid,ex,null);return;}
                injecting=true;el.innerHTML='';el.style.cssText='display:flex;flex-direction:column;flex:1;padding:0;overflow:hidden;';
                var ww=document.createElement('div');ww.id='wcpos-panel-content';ww.setAttribute('data-panel',pid);el.appendChild(ww);loadPanel(pid,ww,null);
                setTimeout(function(){injecting=false;},500);
            }

            /* ── Toast admin ── */
            var _toastShown=false;
            function showAdminToast(msg){
                if(_toastShown)return;_toastShown=true;
                var t=document.createElement('div');
                t.style.cssText='position:fixed;bottom:20px;right:20px;background:#f0a500;color:#1d2327;'
                    +'padding:12px 20px;border-radius:6px;font-size:13px;font-weight:600;'
                    +'z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,.15);max-width:320px;';
                t.textContent=msg;document.body.appendChild(t);
                setTimeout(function(){if(t.remove)t.remove();},6000);
            }

            /* ── Check caisse ── */
            function checkCaisse(){
                var tab=currentTab(),isPOS=(tab==='products'||tab==='orders'||tab===null);
                if(!isPOS){if(window.__hideOverlay)window.__hideOverlay();return;}
                fetch(REST+'/caisse/status',{method:'POST',credentials:'include'})
                .then(function(r){return r.json();})
                .then(function(d){
                    console.log('[custom] caisse open='+d.open+' real_open='+d.real_open);
                    if(d.open){if(window.__hideOverlay)window.__hideOverlay();}
                    else{if(window.__showOverlay)window.__showOverlay(d.message||'');}
                })
                .catch(function(e){console.error('[custom] caisse erreur:',e.message);});
            }

            /* ── MutationObserver ── */
            new MutationObserver(function(muts){
                var internal=muts.every(function(m){var t=m.target;while(t){if(t.id==='wcpos-panel-content'||t.id==='wpp'||t.id==='wco')return true;t=t.parentElement;}return false;});
                if(internal)return;
                hideProElements();injectPanel();
            }).observe(document.body,{childList:true,subtree:true});

            /* ── Polling retour POS + périodique ── */
            var _pwa=false;
            setInterval(function(){
                var p=document.getElementById('wcpos-panel-content'),w=document.getElementById('wpp');
                var active=(p&&p.innerHTML.length>50)||(w&&w.style.display!=='none'&&w.innerHTML.length>50);
                if(active){if(window.__hideOverlay)window.__hideOverlay();_pwa=true;}
                else if(_pwa){_pwa=false;if(!window.wcposAuth.canEdit())checkCaisse();}
            },1000);
            setInterval(function(){if(!window.wcposAuth.canEdit())checkCaisse();},30000);

            /* ── Init selon rôle ── */
            window.wcposAuth.onReady(function(canEdit){
                console.log('[custom] onReady canEdit='+canEdit);
                if(canEdit){
                    if(window.__hideOverlay)window.__hideOverlay();
                    fetch(REST+'/caisse/status',{method:'POST',credentials:'include'})
                    .then(function(r){return r.json();})
                    .then(function(d){var isOpen=(d.real_open!==undefined)?d.real_open:d.open;if(!isOpen)showAdminToast('\u26a0\ufe0f Caisse ferm\u00e9e \u2013 mode administrateur');})
                    .catch(function(){});
                } else {
                    checkCaisse();
                }
            });

            console.log('[custom] init OK');
        })();`).catch((e: Error) => log.error('[custom] ' + e.message));
    }

    /* ════════════════════════════════════════════════════════════════════════
       BLOC 4 — Injection panel #wpp (géométrie)
       ════════════════════════════════════════════════════════════════════════ */
    function runPanelForTab(tab: string | null): void {
        if (!mainWindow || mainWindow.isDestroyed()) return;

        if (!tab) {
            mainWindow.webContents.executeJavaScript(`(function(){
                var w=document.getElementById('wpp');
                if(w){w.style.setProperty('display','none','important');console.log('[panel] caché');}
            })();`).catch(() => {});
            return;
        }

        log.info(`[panel] → ${tab}`);

        mainWindow.webContents.executeJavaScript(`(function(){
            try{
                var tab=${JSON.stringify(tab)};
                if(!document.querySelector('[data-testid="search-products"]')){console.log('[panel] hors POS');return;}
                if(!window.__setup){console.log('[panel] setup absent');return;}

                var wpp=document.getElementById('wpp');
                if(wpp&&wpp.getAttribute('data-pid')===tab&&wpp.innerHTML.length>100){
                    wpp.style.removeProperty('display');console.log('[panel] re-affiche tab='+tab);return;
                }

                var W=window.innerWidth;

                /* Détection structurelle : barre nav gauche */
                var navLeft=56;
                var navSel=['[class*="TabBar"]','[class*="Sidebar"]','[class*="Navigation"]','[class*="sidebar"]','nav[class]'];
                for(var ni=0;ni<navSel.length;ni++){
                    var ne=document.querySelector(navSel[ni]);
                    if(ne){var nr=ne.getBoundingClientRect();if(nr.left===0&&nr.width>0&&nr.width<W*0.2){navLeft=Math.round(nr.right);break;}}
                }

                /* Détection structurelle : bas du header */
                var hdrBottom=50;
                document.querySelectorAll('header,nav,[role="banner"],[class*="Header"],[class*="TopBar"],[class*="AppBar"],[class*="Toolbar"],[class*="header"],[class*="topbar"]')
                .forEach(function(he){
                    var hr=he.getBoundingClientRect();
                    if(hr.top<=5&&hr.width>W*0.5&&hr.height>10&&hr.height<200)
                        if(Math.round(hr.bottom)>hdrBottom)hdrBottom=Math.round(hr.bottom);
                });

                console.log('[panel] tab='+tab+' navLeft='+navLeft+' hdrBottom='+hdrBottom);

                if(wpp)wpp.remove();
                var w=document.createElement('div');
                w.id='wpp';w.setAttribute('data-pid',tab);
                w.style.cssText='position:fixed;top:'+hdrBottom+'px;left:'+navLeft+'px;right:0;bottom:0;'
                    +'z-index:50;background:#f0f0f1;overflow-y:auto;box-sizing:border-box';
                document.body.appendChild(w);
                window.__loadPanel(tab,w,null,true);
                console.log('[panel] #wpp créé');
            }catch(e){console.error('[panel] EXCEPTION',e.message,e.stack);}
        })\`).catch((e: Error) => log.error(\`[panel] \${e.message}\`));
    }

    /* ── Orchestration ───────────────────────────────────────────────────── */
    let lastTab: string | null = null;

    function onNavigate(label: string, url?: string): void {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const currentUrl = url ?? mainWindow.webContents.getURL();
        const tab = tabFromUrl(currentUrl);
        log.info(`[${label}] url=${currentUrl} tab=${tab}`);
        runAntiPro();
        runSetup();
        runWcposCustom();
        if (tab !== lastTab) {
            lastTab = tab;
            setTimeout(() => runPanelForTab(tab), 400);
        }
    }

    mainWindow.webContents.on('dom-ready', () => {
        mainWindow?.setTitle(APP_VERSION);
        log.info('[dom-ready]');
        onNavigate('dom-ready');
    });
    mainWindow.webContents.on('did-navigate', (_e, url) => {
        log.info(`[did-navigate] ${url}`);
        lastTab = null;
        onNavigate('did-navigate', url);
    });
    mainWindow.webContents.on('did-navigate-in-page', (_e, url) => {
        log.info(`[did-navigate-in-page] ${url}`);
        onNavigate('did-navigate-in-page', url);
    });

    let pollCount = 0;
    const pollTimer = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(pollTimer); return; }
        const url = mainWindow.webContents.getURL();
        const tab = tabFromUrl(url);
        log.info(`[poll ${pollCount + 1}/10] url=${url} tab=${tab}`);
        runAntiPro(); runSetup(); runWcposCustom();
        if (tab && tab !== lastTab) { lastTab = tab; setTimeout(() => runPanelForTab(tab), 400); }
        if (++pollCount >= 10) clearInterval(pollTimer);
    }, 2000);

    mainWindow.on('ready-to-show', () => {
        if (!mainWindow) throw new Error('"mainWindow" is not defined');
        if (process.env.START_MINIMIZED) mainWindow.minimize();
        else mainWindow.show();
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url); return { action: 'deny' };
    });

    let retryCount = 0;
    mainWindow.webContents.on('did-fail-load', async (_e, _code, desc) => {
        log.error(`[did-fail-load] ${desc}`);
        if (desc === 'ERR_CONNECTION_REFUSED') {
            if (retryCount >= 30) return;
            retryCount++;
            setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) loadURL(mainWindow); }, 2000);
        }
    });
};

export const getMainWindow = (): BrowserWindow | null => mainWindow;
