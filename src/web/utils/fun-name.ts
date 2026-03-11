/**
 * Generates fun adjective-noun branch names like "swift-falcon" or "brave-otter".
 * All words are lowercase, git-branch-safe, and short enough to not be annoying.
 */

const adjectives = [
  'brave', 'calm', 'clever', 'cosmic', 'crazy', 'crispy', 'daring', 'dizzy',
  'eager', 'fancy', 'fierce', 'fluffy', 'funky', 'gentle', 'giant', 'golden',
  'groovy', 'happy', 'hasty', 'hidden', 'hungry', 'icy', 'jazzy', 'jolly',
  'keen', 'lazy', 'lively', 'lucky', 'mighty', 'misty', 'noble', 'nutty',
  'proud', 'quick', 'quiet', 'rapid', 'rebel', 'rusty', 'savage', 'shiny',
  'silent', 'slick', 'sneaky', 'spicy', 'steady', 'stormy', 'subtle', 'swift',
  'tiny', 'tough', 'turbo', 'vivid', 'warm', 'wicked', 'wild', 'witty',
  'zany', 'zen', 'bold', 'chill', 'epic', 'frosty',
];

const nouns = [
  'badger', 'bear', 'cobra', 'condor', 'coyote', 'crane', 'dolphin', 'dragon',
  'eagle', 'falcon', 'ferret', 'fox', 'gecko', 'goose', 'hawk', 'heron',
  'horse', 'husky', 'iguana', 'jaguar', 'koala', 'lemur', 'leopard', 'lion',
  'llama', 'lynx', 'mantis', 'moose', 'narwhal', 'newt', 'otter', 'owl',
  'panda', 'parrot', 'pelican', 'penguin', 'phoenix', 'puma', 'python', 'raven',
  'rhino', 'salmon', 'shark', 'sloth', 'sphinx', 'squid', 'stork', 'swan',
  'tiger', 'toucan', 'turtle', 'viper', 'walrus', 'wasp', 'whale', 'wolf',
  'wombat', 'yak', 'zebra', 'bison', 'crow', 'dove', 'elk', 'finch',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Returns a fun name like "swift-falcon". */
export function generateFunName(): string {
  return `${pick(adjectives)}-${pick(nouns)}`;
}
