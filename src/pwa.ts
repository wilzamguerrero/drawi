/**
 * PWA — registro del service worker + instalabilidad profesional.
 *
 * Cubre:
 *  - registro de /sw.js en window.load
 *  - actualizaciones con UX ("Actualización disponible → Actualizar")
 *  - beforeinstallprompt (Android/desktop) con banner propio
 *  - guía iOS ("Compartir → Añadir a pantalla de inicio")
 *  - estado offline/online silencioso y aviso de "Listo para usar sin conexión"
 *
 * Diseño: un único banner inferior central, priorizando update > install > iOS.
 * Respeto al usuario: si descarta, no se insiste en 7 días. No bloquea el lienzo.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const LS_INSTALL_DISMISS = "zence.pwa.install.dismissed";
const LS_IOS_DISMISS = "zence.pwa.ios.dismissed";
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let swReg: ServiceWorkerRegistration | null = null;
let updateWaiting: ServiceWorker | null = null;
let bannerEl: HTMLDivElement | null = null;
let bannerKind: "update" | "install" | "ios" | null = null;
let bannerTimer = 0;

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  const ua = window.navigator.userAgent;
  const iOSUA = /iPad|iPhone|iPod/.test(ua);
  const iPadOS = window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1;
  return iOSUA || iPadOS;
}

function wasDismissedRecently(key: string): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return false;
    const ts = Number(raw);
    return Number.isFinite(ts) && Date.now() - ts < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

function markDismissed(key: string): void {
  try {
    window.localStorage.setItem(key, String(Date.now()));
  } catch {}
}

function canShowInstall(): boolean {
  if (isStandalone()) return false;
  if (wasDismissedRecently(LS_INSTALL_DISMISS)) return false;
  return !!deferredPrompt;
}

function canShowIOS(): boolean {
  if (!isIOS()) return false;
  if (isStandalone()) return false;
  if (wasDismissedRecently(LS_IOS_DISMISS)) return false;
  // si ya hay prompt nativo, preferimos ese
  if (deferredPrompt) return false;
  return true;
}

// ------------------------------------------------------------ UI banner

function ensureBanner(): HTMLDivElement {
  if (bannerEl) return bannerEl;
  const el = document.createElement("div");
  el.className = "pwa-banner";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-live", "polite");
  el.hidden = true;
  document.body.appendChild(el);
  bannerEl = el;
  return el;
}

function hideBanner(): void {
  if (!bannerEl) return;
  bannerEl.hidden = true;
  bannerEl.innerHTML = "";
  bannerKind = null;
  window.clearTimeout(bannerTimer);
}

function showUpdateBanner(): void {
  if (bannerKind === "update") return;
  const el = ensureBanner();
  bannerKind = "update";
  el.innerHTML = "";
  el.hidden = false;
  el.classList.add("is-visible");

  const dot = document.createElement("span");
  dot.className = "pwa-banner-dot";
  dot.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "pwa-banner-text";
  text.textContent = "Actualización disponible";

  const actions = document.createElement("div");
  actions.className = "pwa-banner-actions";

  const updateBtn = document.createElement("button");
  updateBtn.type = "button";
  updateBtn.className = "pwa-banner-btn is-primary";
  updateBtn.textContent = "Actualizar";
  updateBtn.addEventListener("click", () => {
    if (updateWaiting) {
      updateWaiting.postMessage({ type: "SKIP_WAITING" });
    } else if (swReg?.waiting) {
      swReg.waiting.postMessage({ type: "SKIP_WAITING" });
    }
    updateBtn.textContent = "Actualizando…";
    updateBtn.disabled = true;
    // fallback: si controllerchange no llega, recarga igual
    window.setTimeout(() => window.location.reload(), 1800);
  });

  const laterBtn = document.createElement("button");
  laterBtn.type = "button";
  laterBtn.className = "pwa-banner-btn";
  laterBtn.textContent = "Más tarde";
  laterBtn.addEventListener("click", hideBanner);

  actions.append(updateBtn, laterBtn);
  el.append(dot, text, actions);
}

function showInstallBanner(): void {
  if (!canShowInstall()) return;
  // update tiene prioridad
  if (bannerKind === "update") return;
  const el = ensureBanner();
  bannerKind = "install";
  el.hidden = false;
  el.innerHTML = "";

  const icon = document.createElement("span");
  icon.className = "pwa-banner-icon";
  icon.setAttribute("aria-hidden", "true");
  // gota Zence (inline, sin recursos extra)
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#0a0a0a"/><circle cx="14" cy="9" r="2.2" fill="white"/><circle cx="8" cy="14.5" r="1.6" fill="white"/><circle cx="12" cy="12" r="5.2" fill="white"/></svg>';

  const text = document.createElement("span");
  text.className = "pwa-banner-text";
  text.textContent = "Instalar Zence Draw";

  const actions = document.createElement("div");
  actions.className = "pwa-banner-actions";

  const installBtn = document.createElement("button");
  installBtn.type = "button";
  installBtn.className = "pwa-banner-btn is-primary";
  installBtn.textContent = "Instalar";
  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    const prompt = deferredPrompt;
    installBtn.textContent = "Abriendo…";
    installBtn.disabled = true;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "accepted") hideBanner();
      else {
        installBtn.textContent = "Instalar";
        installBtn.disabled = false;
      }
    } catch {
      installBtn.textContent = "Instalar";
      installBtn.disabled = false;
    } finally {
      deferredPrompt = null;
    }
  });

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "pwa-banner-btn";
  dismissBtn.setAttribute("aria-label", "Descartar");
  dismissBtn.textContent = "Ahora no";
  dismissBtn.addEventListener("click", () => {
    markDismissed(LS_INSTALL_DISMISS);
    hideBanner();
  });

  actions.append(installBtn, dismissBtn);
  el.append(icon, text, actions);
}

function showIOSBanner(): void {
  if (!canShowIOS()) return;
  if (bannerKind === "update" || bannerKind === "install") return;
  const el = ensureBanner();
  bannerKind = "ios";
  el.hidden = false;
  el.innerHTML = "";
  el.classList.add("is-ios");

  const icon = document.createElement("span");
  icon.className = "pwa-banner-icon";
  icon.textContent = "⬆";
  icon.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "pwa-banner-text pwa-banner-text--wrap";
  text.textContent = "En iPhone: Compartir → Añadir a pantalla de inicio";

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "pwa-banner-btn";
  dismissBtn.textContent = "Entendido";
  dismissBtn.addEventListener("click", () => {
    markDismissed(LS_IOS_DISMISS);
    hideBanner();
  });

  const actions = document.createElement("div");
  actions.className = "pwa-banner-actions";
  actions.append(dismissBtn);

  el.append(icon, text, actions);
}

function scheduleInstallBanner(delayMs = 1600): void {
  window.clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => {
    // no mostrar sobre splash: espera a que se haya ido
    const splash = document.getElementById("splash");
    const splashVisible = !!splash && !splash.classList.contains("is-gone");
    if (splashVisible) {
      // reintenta un poco después
      scheduleInstallBanner(900);
      return;
    }
    showInstallBanner();
  }, delayMs);
}

function scheduleIOSBanner(delayMs = 2800): void {
  window.clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => {
    const splash = document.getElementById("splash");
    const splashVisible = !!splash && !splash.classList.contains("is-gone");
    if (splashVisible) {
      scheduleIOSBanner(900);
      return;
    }
    showIOSBanner();
  }, delayMs);
}

// ------------------------------------------------------------ registro

/**
 * Retira el service worker en desarrollo, y borra sus caches.
 *
 * Hace falta porque `sw.js` sirve los scripts con cache-first: en produccion eso
 * es correcto, porque el bundle lleva hash en el nombre y un build nuevo es una
 * URL nueva. En desarrollo las URLs de los modulos son ESTABLES, asi que el
 * service worker devolvia siempre la copia cacheada y **ningun cambio en el
 * codigo se veia**, por mucho que se recargara. Es un fallo que cuesta horas
 * porque no se parece a un fallo: la aplicacion funciona, solo que es la de ayer.
 *
 * Se retira solo, sin que nadie tenga que abrir las herramientas del navegador.
 */
async function dropServiceWorkerInDev(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    if (regs.length > 0) {
      await Promise.all(regs.map((r) => r.unregister()));
      console.warn(
        "[drawi] Service worker retirado: su cache servia modulos viejos en desarrollo.",
      );
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    // Mientras el service worker siga CONTROLANDO esta pagina, sus manejadores
    // siguen en pie aunque ya no este registrado. Una recarga lo suelta; el
    // centinela de sesion impide que eso se convierta en un bucle de recargas.
    if (navigator.serviceWorker.controller && !devReloaded()) {
      markDevReloaded();
      window.location.reload();
    }
  } catch (err) {
    console.warn("[drawi] no se pudo retirar el service worker:", err);
  }
}

const LS_DEV_RELOAD = "zence.pwa.dev-reload";

function devReloaded(): boolean {
  try {
    return window.sessionStorage.getItem(LS_DEV_RELOAD) === "1";
  } catch {
    // Sin sessionStorage no se puede garantizar que no haya bucle: se prefiere no
    // recargar y dejar que la limpieza de caches haga el trabajo.
    return true;
  }
}

function markDevReloaded(): void {
  try {
    window.sessionStorage.setItem(LS_DEV_RELOAD, "1");
  } catch {}
}

async function registerSW(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  // Evita registrar dos veces en HMR
  if (swReg) return;

  try {
    const reg = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    swReg = reg;

    // Si ya hay un waiting al cargar (actualización pendiente)
    if (reg.waiting) {
      updateWaiting = reg.waiting;
      showUpdateBanner();
    }

    reg.addEventListener("updatefound", () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          // nueva versión lista, la anterior sigue controlando
          updateWaiting = reg.waiting ?? installing;
          showUpdateBanner();
        }
      });
    });

    // Polling suave: revisa actualización cada 60s y al volver a foco
    let updateTimer = window.setInterval(() => reg.update().catch(() => {}), 60_000);
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update().catch(() => {});
    });
    window.addEventListener("focus", () => reg.update().catch(() => {}));

    // Limpieza del intervalo si se descarga el SW
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      window.clearInterval(updateTimer);
    });

    // Cuando el SW toma control, recarga una vez para activar la nueva versión
    let refreshed = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshed) return;
      refreshed = true;
      window.location.reload();
    });

    // Mensajes del SW
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
      if (event.data?.type === "SW_ACTIVATED") {
        // listo offline (silencioso, útil para debug)
        console.debug("[PWA] offline ready");
      }
    });

    // Check inmediato por si había update mientras estaba cerrado
    reg.update().catch(() => {});
  } catch (err) {
    console.warn("[PWA] no se pudo registrar el service worker:", err);
  }
}

export function initPWA(): void {
  // En desarrollo NO se registra, y ademas se retira el que hubiera. Ver
  // `dropServiceWorkerInDev`: su cache convertia cada cambio en invisible.
  if (import.meta.env.DEV) {
    void dropServiceWorkerInDev();
    if (canShowIOS()) scheduleIOSBanner(3200);
    return;
  }

  // No registrar en contextos inseguros salvo localhost (el navegador ya lo bloquea)
  if (!("serviceWorker" in navigator)) {
    // Aun sin SW, muestra guía iOS si aplica
    if (canShowIOS()) scheduleIOSBanner();
    return;
  }

  // Captura del prompt de instalación
  window.addEventListener("beforeinstallprompt", (e: Event) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    // Muestra banner propio (con retardo para no chocar con la carga)
    scheduleInstallBanner();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    hideBanner();
    try {
      window.localStorage.removeItem(LS_INSTALL_DISMISS);
    } catch {}
    console.debug("[PWA] app instalada");
  });

  // iOS: sin beforeinstallprompt
  if (canShowIOS()) scheduleIOSBanner(3200);

  // Registro diferido a window.load para no competir con el bundle
  if (document.readyState === "complete") {
    registerSW();
  } else {
    window.addEventListener("load", () => registerSW(), { once: true });
  }

  // API de depuración
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__pwa = {
      get deferredPrompt() {
        return deferredPrompt;
      },
      get registration() {
        return swReg;
      },
      promptInstall: async () => {
        if (!deferredPrompt) return "no-prompt";
        await deferredPrompt.prompt();
        const c = await deferredPrompt.userChoice;
        return c.outcome;
      },
      showInstall: showInstallBanner,
      showIOS: showIOSBanner,
      showUpdate: showUpdateBanner,
      hide: hideBanner,
    };
  }
}

// Expuestos para UI externa (topbar, etc.) si se quiere un botón manual
export function canPromptInstall(): boolean {
  return !!deferredPrompt && !isStandalone();
}

export async function promptInstall(): Promise<"accepted" | "dismissed" | "no-prompt"> {
  if (!deferredPrompt) return "no-prompt";
  await deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  const outcome = choice.outcome;
  deferredPrompt = null;
  if (outcome === "accepted") hideBanner();
  return outcome;
}

export function isInstalled(): boolean {
  return isStandalone();
}
