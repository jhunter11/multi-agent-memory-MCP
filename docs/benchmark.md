# Benchmark

## Public synthetic fixture

The fixture seed is `20260828`. The fixture contains:

- 100 direct questions.
- 100 one-hop questions.
- 100 two-hop questions.
- 100 negative questions.
- 350 decoy records.

The fixture hash is `3355d651277048f4cc7b5c309d28057b854f9271105d03fc4e86dc7a0abedca5`.

The test measures Recall@5, MRR, direct recall, linked recall, negative abstention, direct loss, and decoy contamination.

## Result

The two-hop configuration reached `1.0000` Recall@5. Lexical-only retrieval reached `0.3333`.

Direct Recall@5 stayed at `1.0000`. Negative abstention stayed at `1.0000`. Decoy contamination stayed at `0.0000`.

The two-hop MRR was `0.6111`. Linked records rank after their lexical seed, which explains the MRR difference.

## Qualification

This is the strongest memory configuration tested on this fixture family. It is not a universal optimum.

The synthetic keys create clear graph-retrieval cases. Real projects have ambiguity, stale records, conflicting edges, and different query distributions.

Run a project-specific evaluation before you change a production memory policy.

## Private pilot summary

An earlier private fixture family tested one-hop retrieval in a multi-agent tiered system.

Direct Recall@5 stayed at `0.92`. Link-only Recall@5 rose from `0.00` to `0.27`. A 350-decoy run reached `0.19`.

Those numbers describe one private fixture family. This repository contains no source records or question text from that pilot.
