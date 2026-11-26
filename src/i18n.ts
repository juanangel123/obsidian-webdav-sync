// The plugin's user-facing text, per language. `en` is the source; every other language is typed against it, so a
// missing or misshaped string fails the type-check. Logs and the engine's own error messages stay in English;
// `errorText` turns a known error into a message in the user's language.
//
// Adding a language: a dictionary `xx: Strings = { … }` below and its entry in `languages`.

import { DecryptError } from "./crypto";
import { FileError, LocalChanged, NoVault } from "./sync";
import { TimeoutError, WebDavError } from "./webdav";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const en = {
  ribbon: "Sync with WebDAV",
  cmdSyncNow: "Sync now",
  cmdForget: "Forget sync state",
  forgotten: "state forgotten: the next sync compares every file and deletes nothing.",

  statusSyncing: "Syncing…",
  statusSynced: (time: string) => `Synced ${time}`,
  statusFailed: (time: string) => `Sync failed ${time}`,
  statusPaused: (reason: string) => `Sync paused: ${reason}`,

  fillSettings: "fill in the settings first.",
  notUrl: "the server address is not a URL.",
  notHttps: "the server address must use https.",
  alreadySyncing: "already syncing; another run follows.",
  pausedDeletions: (n: number) => `${plural(n, "deletion", "deletions")} to confirm (Sync now)`,
  pausedNotice: (n: number) => `paused, a sync would delete ${plural(n, "file", "files")}. Press Sync now to review.`,

  up: (n: number) => `${n} up`,
  down: (n: number) => `${n} down`,
  trashedHere: (n: number) => `${n} moved to this vault's trash`,
  deletedOnServer: (n: number) => `${n} deleted on the server`,
  upToDate: "up to date",
  conflicts: (list: string) => `conflict, kept both:\n${list}`,
  failed: (n: number, list: string) => `${n} failed:\n${list}`,
  skipped: (list: string) => `left out (too big, or a name the server can't take):\n${list}`,
  deletedElsewhere: (n: number) => `${n} deleted on another device, moved to this vault's trash`,

  modalTitle: "WebDAV Sync: many deletions",
  modalToTrash: "To move to this vault's trash, deleted on the server or another device",
  modalToDelete: "To delete on the server, deleted on this device",
  modalList: (title: string, n: number) => `${title} (${n}):`,
  modalMore: (n: number) => `…and ${n} more`,
  modalWarning: "If this is not what you expect (a wrong server, a wiped folder), cancel. Automatic syncing stays paused until you sync by hand.",
  cancel: "Cancel",
  deleteAndSync: "Delete and sync",

  server: "Server",
  serverDesc: "The WebDAV folder for this vault, https://… — an empty folder, one per vault.",
  username: "Username",
  password: "Password",
  passwordDesc: "Kept in Obsidian's secret storage, not in the vault.",
  passphrase: "Encryption passphrase",
  passphraseDesc:
    "Encrypts every note and its name before it leaves this device; the same on every device. The first device's first sync sets it. Without it the notes on the server can't be read: keep it safe.",
  interval: "Sync every (minutes)",
  intervalDesc: "0: never.",
  maxFile: "Max file size (MB)",
  maxFileDesc: "Bigger files are left out of the sync.",
  onStartup: "Sync on startup and on return",
  onStartupDesc: "When Obsidian opens, and when you come back to it after a minute or more away.",
  afterEdit: "Sync after editing",
  afterEditDesc: (s: number) => `${s} seconds after the last change.`,
  check: "Check connection",
  checkDesc: "Logs in and checks the encryption passphrase. On an empty server, sets the vault up with it.",
  checkButton: "Check",
  fillFour: "fill in the four fields first.",
  connected: "connected, encryption passphrase right.",
  connectedCreated: "connected; vault set up on the server with this encryption passphrase.",
  syncNow: "Sync now",
  syncButton: "Sync",

  errPassphrase: "wrong encryption passphrase",
  errFormat: "the server's vault is in a format this version doesn't know: update the plugin",
  errMeta: "sync.json on the server is damaged",
  errDecrypt: (why: string) => `cannot decrypt (${why})`,
  whyNotSealed: "not a file of this plugin",
  whyDamaged: "damaged file",
  whyWrongName: "file under the wrong name",
  whyWrongKey: "wrong encryption passphrase or damaged file",
  errNoVault: "no vault on this server yet: press Sync now on the first device to set it up",
  errNotEmpty: "this server folder holds notes but no sync.json: refusing to start a new vault over them",
  errVanished: "sync.json vanished right after it was written",
  errGone: "gone from the server since the listing",
  errCaseClash: (other: string) => `differs only in case from "${other}": rename one of them`,
  errBadName: "a name this device can't hold as is",
  errChangedHere: "changed on this device during the sync; the next sync retries",
  errLogin: "wrong user or password",
  errForbidden: "the server refused access",
  errNotFound: "not found on the server: check the address",
  errHttp: (status: number) => `the server answered HTTP ${status}`,
  errTimeout: (s: number) => `the server gave no answer in ${s} s`,
  errNetwork: "no connection to the server: check the network or the address",
};

export type Strings = typeof en;

const es: Strings = {
  ribbon: "Sincronizar con WebDAV",
  cmdSyncNow: "Sincronizar ahora",
  cmdForget: "Olvidar el estado de sincronización",
  forgotten: "estado olvidado: la siguiente sincronización compara todos los archivos y no borra nada.",

  statusSyncing: "Sincronizando…",
  statusSynced: (time) => `Sincronizado a las ${time}`,
  statusFailed: (time) => `Falló a las ${time}`,
  statusPaused: (reason) => `Sincronización en pausa: ${reason}`,

  fillSettings: "rellena primero los ajustes.",
  notUrl: "la dirección del servidor no es una URL.",
  notHttps: "la dirección del servidor debe usar https.",
  alreadySyncing: "ya se está sincronizando; al terminar se sincroniza otra vez.",
  pausedDeletions: (n) => `${plural(n, "borrado", "borrados")} por confirmar (Sincronizar ahora)`,
  pausedNotice: (n) =>
    `en pausa: una sincronización borraría ${plural(n, "archivo", "archivos")}. Pulsa Sincronizar ahora para revisarlo.`,

  up: (n) => plural(n, "subido", "subidos"),
  down: (n) => plural(n, "descargado", "descargados"),
  trashedHere: (n) => `${plural(n, "archivo", "archivos")} a la papelera de Obsidian`,
  deletedOnServer: (n) => `${plural(n, "borrado", "borrados")} en el servidor`,
  upToDate: "todo al día",
  conflicts: (list) => `conflicto, se conservan las dos versiones:\n${list}`,
  failed: (n, list) => `${plural(n, "error", "errores")}:\n${list}`,
  skipped: (list) => `sin sincronizar (demasiado grandes, o un nombre que el servidor no admite):\n${list}`,
  deletedElsewhere: (n) =>
    `${plural(n, "archivo borrado", "archivos borrados")} en otro dispositivo (a la papelera de Obsidian)`,

  modalTitle: "WebDAV Sync: muchos borrados",
  modalToTrash: "A la papelera de Obsidian (borrados en el servidor o en otro dispositivo)",
  modalToDelete: "A borrar en el servidor (borrados en este dispositivo)",
  modalList: (title, n) => `${title} (${n}):`,
  modalMore: (n) => `…y ${n} más`,
  modalWarning:
    "Si no es lo que esperabas (un servidor equivocado, una carpeta vaciada), cancela. La sincronización automática sigue en pausa hasta que sincronices a mano.",
  cancel: "Cancelar",
  deleteAndSync: "Borrar y sincronizar",

  server: "Servidor",
  serverDesc: "La carpeta WebDAV de esta bóveda, https://… — una carpeta vacía, una por bóveda.",
  username: "Usuario",
  password: "Contraseña",
  passwordDesc: "Se guarda en el almacén de secretos de Obsidian, no en la bóveda.",
  passphrase: "Frase de cifrado",
  passphraseDesc:
    "Cifra cada nota y su nombre antes de salir de este dispositivo; la misma en todos. La fija la primera sincronización del primer dispositivo. Sin ella no se pueden leer las notas del servidor: guárdala bien.",
  interval: "Sincronizar cada (minutos)",
  intervalDesc: "0: nunca.",
  maxFile: "Tamaño máximo de archivo (MB)",
  maxFileDesc: "Los archivos más grandes no se sincronizan.",
  onStartup: "Sincronizar al abrir y al volver",
  onStartupDesc: "Al abrir Obsidian y al volver a él tras un minuto o más fuera.",
  afterEdit: "Sincronizar después de editar",
  afterEditDesc: (s) => `${s} segundos después del último cambio.`,
  check: "Comprobar conexión",
  checkDesc: "Inicia sesión y comprueba la frase de cifrado. En un servidor vacío, crea la bóveda con ella.",
  checkButton: "Comprobar",
  fillFour: "rellena primero los cuatro campos.",
  connected: "conectado, frase de cifrado correcta.",
  connectedCreated: "conectado; bóveda creada en el servidor con esta frase de cifrado.",
  syncNow: "Sincronizar ahora",
  syncButton: "Sincronizar",

  errPassphrase: "la frase de cifrado no es correcta",
  errFormat: "la bóveda del servidor tiene un formato que esta versión no conoce: actualiza el complemento",
  errMeta: "el sync.json del servidor está dañado",
  errDecrypt: (why) => `no se puede descifrar (${why})`,
  whyNotSealed: "no es un archivo de este complemento",
  whyDamaged: "archivo dañado",
  whyWrongName: "archivo con un nombre que no le corresponde",
  whyWrongKey: "frase de cifrado incorrecta o archivo dañado",
  errNoVault: "aún no hay bóveda en este servidor: pulsa Sincronizar ahora en el primer dispositivo para crearla",
  errNotEmpty: "esta carpeta del servidor tiene notas pero no sync.json: no se crea una bóveda nueva encima",
  errVanished: "el sync.json desapareció justo después de escribirlo",
  errGone: "ya no está en el servidor",
  errCaseClash: (other) => `solo se diferencia en mayúsculas de "${other}": renombra uno de los dos`,
  errBadName: "un nombre que este dispositivo no admite tal cual",
  errChangedHere: "cambió en este dispositivo durante la sincronización; la siguiente lo reintenta",
  errLogin: "usuario o contraseña incorrectos",
  errForbidden: "el servidor ha denegado el acceso",
  errNotFound: "no existe en el servidor: revisa la dirección",
  errHttp: (status) => `el servidor respondió HTTP ${status}`,
  errTimeout: (s) => `el servidor no respondió en ${s} s`,
  errNetwork: "no hay conexión con el servidor: revisa la red o la dirección",
};

export const languages: Record<string, Strings> = { en, es };

/** The strings for an Obsidian language code ("es", "pt-BR", …); English when there is no dictionary for it. */
export function strings(lang: string): Strings {
  return languages[lang] ?? languages[lang.split("-")[0]] ?? en;
}

/** An error as a message in the user's language; an unknown one keeps its own (English) message. */
export function errorText(t: Strings, err: unknown): string {
  if (err instanceof DecryptError) {
    switch (err.kind) {
      case "passphrase":
        return t.errPassphrase;
      case "format":
        return t.errFormat;
      case "meta":
        return t.errMeta;
      case "notSealed":
        return t.errDecrypt(t.whyNotSealed);
      case "wrongName":
        return t.errDecrypt(t.whyWrongName);
      case "wrongKey":
        return t.errDecrypt(t.whyWrongKey);
      default:
        return t.errDecrypt(t.whyDamaged);
    }
  }
  if (err instanceof NoVault) return err.kind === "none" ? t.errNoVault : err.kind === "notEmpty" ? t.errNotEmpty : t.errVanished;
  if (err instanceof FileError) return err.kind === "gone" ? t.errGone : err.kind === "caseClash" ? t.errCaseClash(err.other) : t.errBadName;
  if (err instanceof LocalChanged) return t.errChangedHere;
  if (err instanceof TimeoutError) return t.errTimeout(err.seconds);
  if (err instanceof WebDavError) {
    if (err.status === 401) return t.errLogin;
    if (err.status === 403) return t.errForbidden;
    if (err.status === 404) return t.errNotFound;
    return t.errHttp(err.status);
  }
  if (err instanceof Error && NETWORK.test(err.message)) return t.errNetwork;
  return err instanceof Error ? err.message : String(err);
}

/** How a request with no answer at all fails: Chromium's net:: codes (Obsidian), Node's, and fetch's own words. */
const NETWORK =
  /net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo|Failed to fetch|NetworkError|Network request failed|Unable to connect/i;
