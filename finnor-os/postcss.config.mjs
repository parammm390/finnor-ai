// Keep builds rooted in this repository. Recovery worktrees can be nested under
// unrelated checkouts that have their own Tailwind/PostCSS configuration; allowing
// config discovery to escape this boundary makes otherwise vanilla CSS builds scan
// the parent checkout and can leave Next's build worker waiting indefinitely.
const config = {
  plugins: {},
};

export default config;
