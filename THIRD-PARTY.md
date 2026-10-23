# Avisos de terceros

Kiji Office usa los componentes siguientes en tiempo de ejecución. Las versiones son las de `package-lock.json` y
`src-tauri/Cargo.lock` en el momento de escribir esto; las licencias salen del `package.json` / `Cargo.toml` de
cada paquete. Cada componente se rige por su propia licencia; el texto completo está en su repositorio y dentro de
su paquete. La licencia de Kiji Office aún no está decidida.

## Runtime

| Componente | Versión | Licencia |
| --- | --- | --- |
| Node.js (sidecar del núcleo, de nodejs.org) | 24 LTS | MIT |

Node.js incluye a su vez componentes con otras licencias (V8, OpenSSL, ICU…); ver `LICENSE` en el archivo oficial.

## Interfaz (npm)

| Paquete | Versión | Licencia |
| --- | --- | --- |
| react, react-dom | 19.3.1 | MIT |
| pixi.js | 8.22.0 | MIT |
| zustand | 5.0.16 | MIT |
| react-markdown | 10.1.0 | MIT |
| remark-gfm | 4.0.1 | MIT |
| @tauri-apps/api | 2.12.4 | Apache-2.0 OR MIT |
| @tauri-apps/plugin-dialog | 2.8.3 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-opener | 2.7.2 | MIT OR Apache-2.0 |

## Núcleo (npm)

| Paquete | Versión | Licencia |
| --- | --- | --- |
| @anthropic-ai/claude-agent-sdk | 0.3.308 | Propietaria: «© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements» de https://code.claude.com/docs/en/legal-and-compliance |
| zod | 4.6.7 | MIT |

El Agent SDK no es de código abierto: su uso está sujeto a los términos legales y comerciales de Anthropic, que
aceptas al usar Claude. Kiji Office no lo modifica.

## Aplicación de escritorio (crates de Rust)

| Crate | Versión | Licencia |
| --- | --- | --- |
| tauri | 2.12.5 | Apache-2.0 OR MIT |
| wry | 0.57.0 | Apache-2.0 OR MIT |
| tao | 0.37.1 | Apache-2.0 |
| tauri-plugin-dialog | 2.8.3 | Apache-2.0 OR MIT |
| tauri-plugin-opener | 2.7.2 | Apache-2.0 OR MIT |
| tauri-plugin-notification | 2.7.0 | Apache-2.0 OR MIT |
| keyring | 4.2.0 | MIT OR Apache-2.0 |
| serde, serde_json | 1.0.229 / 1.0.154 | MIT OR Apache-2.0 |

Las dependencias transitivas (más de 500 crates y paquetes npm) tienen licencias permisivas habituales
(MIT, Apache-2.0, BSD, ISC, MPL-2.0, Unicode); la lista completa sale de `cargo metadata` y `npm ls`.
