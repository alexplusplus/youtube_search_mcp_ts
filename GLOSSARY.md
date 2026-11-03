# YouTube Search

A personal search tool that finds YouTube videos that are both relevant to a query and popular, by intersecting two differently ordered searches.

## Language

**Relevance list**:
The videos YouTube returns for a query ordered by relevance; its positions are the **relevance rank**.
_Avoid_: default search, best match

**Popularity list**:
The videos YouTube returns for the same query ordered by view count.
_Avoid_: views list, top list, viewCount search

**Overlap**:
The videos present in both the relevance list and the popularity list for one query; it is the result set, ordered by relevance rank.
_Avoid_: intersection, subset, common videos

**Fallback**:
Extending both lists with their second page when the first-page overlap has fewer than 5 videos.
_Avoid_: retry, second search, page-2 comparison

**Enriched video**:
A video together with its full details (title, description, channel, views, publication date, length, short URL). It is what both tools return: each video in the overlap, or each video asked for by id or URL. The description is the full one, or a **cleaned description** when the Worker is deployed with cleaning on (`--env clean`). A video in the overlap that YouTube no longer lists keeps only what its search entry showed, without views or length.
_Avoid_: result item, video details, hit

**Cleaned description**:
A video's description with the channel's boilerplate (sponsors, affiliate links, courses, newsletters, socials, bios, disclaimers, hashtags) removed, keeping what is about this video and always keeping its chapter lines. When cleaning fails or finds nothing, it is the full description.
_Avoid_: summary, trimmed description, filtered description
