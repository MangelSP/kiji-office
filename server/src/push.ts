// Push sin contenido. Sin FCM_SERVICE_ACCOUNT solo se registra cuántos tokens hay (nunca los tokens).
import { GoogleAuth } from 'google-auth-library';

export type Push = (tokens: string[]) => void | Promise<void>;

export const logPush: Push = (tokens) => { console.log(`push.wake: ${tokens.length} token(s) (sin FCM)`); };

/** FCM HTTP v1 con la cuenta de servicio (JSON en la variable). Aviso genérico, sin datos. */
export function fcmPush(serviceAccountJson: string): Push {
  const creds = JSON.parse(serviceAccountJson);
  const auth = new GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
  return async (tokens) => {
    const bearer = await auth.getAccessToken();
    await Promise.allSettled(tokens.map((token) =>
      fetch(`https://fcm.googleapis.com/v1/projects/${creds.project_id}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { token, notification: { title: 'Kiji', body: 'Kiji necesita tu respuesta' } } }),
      })));
  };
}
