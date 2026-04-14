# Troubleshooting

## TOM never fires

**Symptom**: long session, `/tom-status` shows raw tokens climbing past `T`, no cycle happens.

Check, in order:

1. **Is `compaction.enabled: false` set in pi settings?** If it's `true`, pi's default threshold may fire first and write a non-TOM compaction entry. Look at the session file — if it contains a `CompactionEntry` without `"marker": "tom-v1"` in `details`, pi fired it.
2. **Is a previous cycle stuck in-flight?** `trig.inFlight` is set to true on `ctx.compact()` and cleared via the completion callback. If the callback never fired (e.g. the previous call threw outside TOM's try/catch), new cycles will be blocked. Restart pi.
3. **Is tool activity constantly resetting the debounce?** A tight tool loop (e.g. a long `grep` + `read` sequence) keeps `lastToolCallAt` fresh, which delays the cycle by `debounceMs` after every tool call. This is intentional. If cycles aren't firing in a long session of tool calls, lower `debounceMs` or accept that the cycle will fire at the next quiet moment.
4. **Are tokens actually above `T`?** Use `/tom-status`. The extension measures raw tokens as `ctx.getContextUsage().tokens - observations - reflections`. If the context usage is reported as `null` (which happens right after a compaction before the next LLM call), no cycle can fire.

## Observer returns empty / cycle is cancelled

**Symptom**: notification `TOM: observer produced no output; skipping cycle`.

Causes:

- Observer model is unauthenticated or returns an empty message. Check provider credentials.
- Abort signal fired mid-call (user hit Ctrl-C). Expected; will retry next turn.
- Observer hit its max token limit producing only whitespace. Increase `observerMaxTokens`.

The cycle is cancelled gracefully — no `CompactionEntry` is written, state is unchanged, raw tokens keep growing until the next fire opportunity.

## Reflector fails but cycle continues

**Symptom**: notification `TOM: reflector failed, keeping observations`.

The reflector LLM call either errored or its output didn't match the `<reflections>...</reflections><keep-ids>...</keep-ids>` format. TOM falls back to keeping the observation list unchanged — you'll get the new observation appended without the reflection cleanup. Observations will keep growing past `R`; each future cycle will try reflection again.

Fix:

- Check the reflector model's output format. Some models (especially small ones) ignore format instructions. Switch to a stronger reflector.
- If using the same model for observer and reflector, consider splitting them. Gemini Flash works for observations but is less reliable at structured output than Sonnet or Haiku.

## Cache hit ratio is lower than expected

**Symptom**: provider billing shows lots of non-cached input tokens even though you're mid-session.

Possible causes:

1. **Your provider is not Anthropic/OpenAI/Gemini.** Only those three have prompt-prefix caching at time of writing. Mistral and Bedrock don't.
2. **Short sessions.** Caching kicks in on the second request within the cache TTL (5 min for Anthropic short, 1h for long). If your turns are minutes apart, caches expire between them.
3. **Reflection fired recently.** Post-reflection, the entire summary text diverges. The next turn pays a full re-tokenization of the summary. This is expected. If it's firing too often, raise `R`.
4. **A non-TOM compaction happened.** If something else compacted the session (user ran `/compact` manually, or `compaction.enabled` was accidentally true), the cache prefix shifts. Check session history.

To verify cache behavior empirically, look at the `cache_read` / `cache_creation` token counts in the provider response metadata. If `cache_read` is near zero on turn 2+, the prefix isn't matching.

## `/tom-status` shows `raw tokens: unknown`

Means `ctx.getContextUsage()` returned `{ tokens: null }`. This happens:

- Right after a compaction, before the next LLM call generates new usage data.
- If the active model doesn't report usage.

Not a problem — cycles are suppressed correctly when tokens is null (the `turn_end` handler returns early).

## "Observer model not found" warnings

```
TOM: observer model google/gemini-2.5-flash not found
```

`ctx.modelRegistry.find("google", "gemini-2.5-flash")` returned undefined. Causes:

- Provider is not registered in pi's model registry.
- Model ID string doesn't match what pi has on file.

Fix: `pi --list-models` (or equivalent) to see what's registered, update `observerModel.id` to match. Or switch provider to one you've already authenticated with.

## Tests pass locally but extension misbehaves in pi

The test suite covers pure logic: state serialization, summary prefix stability, trigger math. It does **not** exercise the full `session_before_compact` flow or LLM calls. If integration behavior is off, the first place to look is `index.ts` — the event wiring is integration-only code not covered by tests. Add `console.error` lines and re-run pi interactively to trace.

## Session migration: upgrading from a different compaction scheme

If an existing session has non-TOM compaction entries (from pi's default, or an older TOM version), `loadState` returns `EMPTY_STATE`. The first TOM cycle effectively starts fresh, with prior raw messages treated as the first batch to compress. No data is lost — prior compaction summaries stay in the session file as historical entries, they're just not continued from.

To migrate cleanly, start a new session. TOM does not attempt to reinterpret foreign compaction schemes.
