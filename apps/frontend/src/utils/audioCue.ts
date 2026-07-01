interface BrowserWindowWithAudioContext extends Window {
  webkitAudioContext?: typeof AudioContext;
}

export function playBellCue(durationMs = 800): Promise<boolean> {
  const contextWindow = window as BrowserWindowWithAudioContext;
  const AudioContextCtor = window.AudioContext ?? contextWindow.webkitAudioContext;
  if (!AudioContextCtor) return Promise.resolve(false);

  try {
    const context = new AudioContextCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const durationSeconds = Math.max(0.25, Math.min(2.5, durationMs / 1000));

    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.24, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + durationSeconds);
    oscillator.connect(gain).connect(context.destination);
    return context
      .resume()
      .then(
        () =>
          new Promise<boolean>((resolve) => {
            oscillator.onended = () => {
              void context.close();
              resolve(true);
            };
            oscillator.start();
            oscillator.stop(context.currentTime + durationSeconds + 0.02);
          })
      )
      .catch(() => {
        void context.close();
        return false;
      });
  } catch {
    return Promise.resolve(false);
  }
}
