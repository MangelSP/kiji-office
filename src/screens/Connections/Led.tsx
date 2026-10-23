// LED de una conexión: verde (probada y bien), ámbar (a medias o sin probar), gris (la última prueba falló).
import type { ConnectionView } from "../../../shared/protocol";
import { LED_TEXT, connectionLed } from "./presets";

export default function Led({ conn }: { conn: Pick<ConnectionView, "lastTestOk" | "toolQuality"> }) {
  const led = connectionLed(conn);
  return <span className={`cx-led cx-led-${led}`} role="img" aria-label={LED_TEXT[led]} title={LED_TEXT[led]} />;
}
