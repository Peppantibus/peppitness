/**
 * Solo per il typecheck Node (tsconfig.functions.json): sottoinsieme delle API Deno usate da
 * index.ts. Il runtime Edge usa i tipi reali di Deno e non importa questo file.
 */
declare namespace Deno {
  const env: { get(name: string): string | undefined }
  function serve(handler: (request: Request) => Response | Promise<Response>): unknown
}
