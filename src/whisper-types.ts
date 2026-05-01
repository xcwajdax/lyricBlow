export type WhisperWord = {
  word: string;
  start: number;
  end: number;
};

export type WhisperResponse = {
  words: WhisperWord[];
  language: string;
  duration: number;
};
