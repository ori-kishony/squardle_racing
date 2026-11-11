export const MODES = ['express', 'regular'];

export function puzzleMode(value = 'express') {
  if (!MODES.includes(value)) throw new Error('mode must be express or regular');
  return value;
}

export const minimumWordLength = mode => mode === 'regular' ? 4 : 3;
