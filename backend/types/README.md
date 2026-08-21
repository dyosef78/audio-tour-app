# Generated types

`supabase.ts` in this folder is **generated, not hand-edited**. Regenerate with:

```bash
npm run types:generate
```

It reads the schema of the **linked remote project**, so push your migrations
before regenerating or the types will describe the old schema:

```bash
npm run db:push && npm run types:generate
```

The file is committed so CI and teammates can typecheck without needing
credentials for the remote project.
