// Parseo SSE mínimo (sin dependencias) para los streams de `chat/completions`.
// Devuelve el contenido de cada evento (`data:` unido con \n). Admite \n, \r\n y \r, comentarios (`:`), eventos
// sin línea en blanco final y trozos partidos en mitad de un carácter UTF-8.

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let data: string[] = [];

  const line = (l: string): string | null => {
    if (l === '') {
      if (data.length === 0) return null;
      const ev = data.join('\n');
      data = [];
      return ev;
    }
    if (l.startsWith(':')) return null;
    const i = l.indexOf(':');
    const field = i === -1 ? l : l.slice(0, i);
    if (field !== 'data') return null;
    let v = i === -1 ? '' : l.slice(i + 1);
    if (v.startsWith(' ')) v = v.slice(1);
    data.push(v);
    return null;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let m: RegExpExecArray | null;
      const re = /\r\n|\n|\r/g;
      let last = 0;
      while ((m = re.exec(buf))) {
        // un `\r` al final del buffer puede ser la mitad de un `\r\n`: se espera al siguiente trozo
        if (m[0] === '\r' && m.index + 1 === buf.length) break;
        const ev = line(buf.slice(last, m.index));
        last = m.index + m[0].length;
        if (ev !== null) yield ev;
      }
      buf = buf.slice(last);
    }
    buf += decoder.decode();
    if (buf !== '') {
      const ev = line(buf);
      if (ev !== null) yield ev;
    }
    if (data.length > 0) yield data.join('\n');
  } finally {
    reader.cancel().catch(() => {});
  }
}
