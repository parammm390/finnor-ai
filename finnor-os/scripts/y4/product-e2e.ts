/** Keep the preregistered entry usable from this repository's CJS package. */
void import('./product-episode.mjs').catch(()=>{
 console.error('Y4_PRODUCT_EPISODE_START_FAILED');
 process.exitCode=1;
});
