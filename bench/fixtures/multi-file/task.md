Fix invoice totals: fractional quantities are currently truncated, and a
zero-percent tax rate is incorrectly treated as the default rate. Preserve
the public exports. Verify both fixes with `node verify.mjs`.
