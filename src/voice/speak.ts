/**
 * Optional server-side text to speech.
 *
 * The dashboard speaks through the browser's own speech synthesis by default,
 * which needs no key, no network and no dependency. It sounds like an operating
 * system, but it works everywhere and it never fails mid demo.
 *
 * When an ElevenLabs key is present this returns real audio instead. Same
 * degradation rule as everywhere else in this build: better with credentials,
 * functional without them, and honest on screen about which one is in use.
 */

export type Synthesiser = {
  /** MPEG audio for the given text. */
  synthesise(text: string): Promise<ArrayBuffer>;
};

export function elevenLabsSynthesiser(config: {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  timeoutMs?: number;
}): Synthesiser {
  // Rachel, a default preset voice, so a key alone is enough to get audio.
  const voiceId = config.voiceId ?? '21m00Tcm4TlvDq8ikWAM';
  const modelId = config.modelId ?? 'eleven_turbo_v2_5';
  const timeoutMs = config.timeoutMs ?? 15_000;

  return {
    async synthesise(text: string): Promise<ArrayBuffer> {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': config.apiKey,
            'content-type': 'application/json',
            accept: 'audio/mpeg',
          },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            text,
            model_id: modelId,
            voice_settings: { stability: 0.4, similarity_boost: 0.7 },
          }),
        },
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`elevenlabs ${response.status}: ${detail.slice(0, 200)}`);
      }

      return response.arrayBuffer();
    },
  };
}
