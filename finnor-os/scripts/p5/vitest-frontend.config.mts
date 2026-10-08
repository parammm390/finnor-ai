import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';

// Replay existing assertions with the application's real path alias.
export default defineConfig({
 root:fileURLToPath(new URL('../../../',import.meta.url)),
 resolve:{alias:{'@':fileURLToPath(new URL('../../../src',import.meta.url))}},
 css:{postcss:{plugins:[]}},
 test:{include:['src/components/centropy/canvas/*.test.ts'],fileParallelism:false},
});
