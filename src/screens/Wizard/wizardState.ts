// Bandera "el asistente ya se completó una vez" (localStorage puede no estar disponible: siempre con try/catch).
const KEY = "kiji.wizardDone";

export function readWizardDone(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function markWizardDone(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* sin almacenamiento: el asistente volverá a mostrarse */
  }
}
