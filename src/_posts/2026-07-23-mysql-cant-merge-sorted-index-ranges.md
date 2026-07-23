---
layout: post
title: "MySQL can't merge sorted index ranges (and the UNION ALL fix)"
description: "An IN filter with one value is fast. Add a second value and MySQL scans the whole table. Why it happens, and the UNION ALL fix."
date: 2026-07-23
permalink: /posts/mysql-cant-merge-sorted-index-ranges/
published: true
---

Filtering an indexed column against a value is usually pretty fast. If you add
the right `ORDER BY` clause, it'll be lightning quick. If you add a second value,
the query might get multiple orders of magnitude slower. 

That's exactly what recently happened to me. I didn't fully understand what was
happening until I analyzed the output of the `EXPLAIN ANALYZE`. Ultimately, I 
constructed a query that was basically as fast as the one-value case. It turned 
out the fix is well known in the MySQL performance community. Peter Zaitsev describes
it [here](https://www.percona.com/blog/possible-optimization-for-sort_merge-and-union-order-by-limit/).
Anyway, I wanted to share the fix step by step, the way I derived it, not just lay
it out like "here's the problem, and here's the solution".

## The setup

I'll demonstrate the problem and the fix using an `activities` table, an append-only
log. Each row records which tenant it belongs to (`account_id`) and which user produced
it (`creator_id`).

```sql
CREATE TABLE activities (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT NOT NULL,
  creator_id BIGINT NOT NULL,
  payload    VARCHAR(64) NOT NULL DEFAULT '',  -- stand-in for the row's contents
  KEY idx_account_creator (account_id, creator_id)
) ENGINE=InnoDB;
```

The seed below puts two users near the start of the log, then buries them under two
million newer rows from a third user, so the two we later query sit far from
the most recent `id` values.

```sql
DELIMITER $$

CREATE PROCEDURE seed_activities()
BEGIN
  DECLARE i INT DEFAULT 1;
  DECLARE base_max_id BIGINT;

  START TRANSACTION;
  WHILE i <= 125000 DO
    INSERT INTO activities (account_id, creator_id)
    VALUES (1, IF(i % 25 = 0, 2, 1));
    SET i = i + 1;
  END WHILE;
  COMMIT;

  SELECT MAX(id) INTO base_max_id FROM activities;

  SET i = 1;
  WHILE i <= 16 DO
    INSERT INTO activities (account_id, creator_id)
    SELECT 1, 3 FROM activities WHERE id <= base_max_id;
    SET i = i + 1;
  END WHILE;
END$$

DELIMITER ;

CALL seed_activities();
```

## The query

The query we care about lists a tenant's most recent activity, narrowed to a few
users:

```sql
SELECT * FROM activities
WHERE account_id = 1
  AND creator_id IN (1, 2)
ORDER BY id DESC
LIMIT 200
```

Naturally, we'll focus on the `idx_account_creator` index. Because InnoDB
appends the primary key to every secondary index, this index is physically
`(account_id, creator_id, id)`. Reading it tells us both which rows match and,
within each `(account_id, creator_id)` group, those rows are already ordered by
`id`. Everything the query needs appears to be in the index and we might
expect MySQL to walk it backward and stop after 200 rows. We'll first show 
it does exactly that for a single user. But for two, it doesn't.

## What MySQL actually does

### Single value

For `creator_id = 1` the index holds one contiguous run of rows for
`(account_id, creator_id) = (1, 1)`, already ordered by `id`. Because
of that, MySQL starts at its high end, reads 200 rows and returns them.

```
-> Limit: 200 row(s)
     (actual time=0.305..0.321 rows=200)
  -> Index lookup on activities using idx_account_creator
     (account_id=1, creator_id=1) (reverse)
       (rows=128788) (actual time=0.305..0.315 rows=200)
```

We can see the index does both jobs at once. It finds the matching rows
and hands them back already ordered. This is the optimal plan we were hoping for.

### Multiple values

With two values the execution plan changes. The index gives us two runs, one per
user, each ordered by `id` on its own. The thing is, their rows are mixed across
the `id` range. Reading just one run won't get you the newest rows overall.
To list the newest 200 across both, we have to combine the two runs.

Before turning to what MySQL does, let's first consider what an ideal execution would look
like. We have two sorted sequences and we want the 200 largest `id`s across both.

The two runs are already sorted, so producing the top 200 across both should take a
single linear pass. We keep a cursor at the high end of each run, repeatedly take
the larger of the two values, and stop after 200 of them. The cost is about 200
reads and 200 comparisons, regardless of how large the runs are. In theory, nothing
in the problem requires reading more rows than the limit.

The issue is that MySQL has no operator for this kind of merge, so it executes a plan
that reads far more than 200 rows. Faced with the IN list and `ORDER BY id`, it
walks the primary key backward and filters as it goes:

```
-> Limit: 200 row(s)
     (actual time=375..375 rows=200)
  -> Filter: (account_id = 1 and creator_id in (1, 2))
       (actual time=375..375 rows=200)
    -> Index scan on activities using PRIMARY (reverse)
         (rows=3075) (actual time=0.05..313 rows=2000000)
```

MySQL scanned two million rows (the whole table!) to return two hundred. 
It expected almost none, that `rows=3075` estimate assumed the two users' 
rows were spread evenly, but I buried them on purpose to make the case 
realistic. A tenant's rows are almost always spread across the `id` range,
they don't sit together near the top.

## Why not use the index?

We've shown the `idx_account_creator` index works well for a single-value query.
So let's force it and see what happens when it's used with two values:

```sql
SELECT * FROM activities FORCE INDEX (idx_account_creator)
WHERE account_id = 1 AND creator_id IN (1, 2)
ORDER BY id DESC
LIMIT 200
```

```
-> Limit: 200 row(s)
     (actual time=103..103 rows=200)
  -> Sort: activities.id DESC, limit input to 200 row(s) per chunk
       (rows=137786) (actual time=103..103 rows=200)
    -> Index range scan on activities using idx_account_creator
       over (account_id = 1 AND creator_id = 1)
        OR (account_id = 1 AND creator_id = 2)
         (rows=137786) (actual time=0.34..89 rows=125000)
```

Better, 125,000 rows instead of two million, but still nowhere near the optimal 200. The
index jumps straight to the two users' rows, so the filtering part is solved first. The
problem is ordering. As we said, MySQL can't merge them, so it reads all 125,000 into a
sort and applies the limit only after sorting. This problem scales with the number of
matching rows. The more rows the two users have, the larger the sort MySQL builds before
it can drop all but 200.

Turns out both options are suboptimal. Left alone, MySQL scans the whole table.
When we force the index, it sorts every matching row. Neither ever pushes the limit down to
where rows are read, because neither can merge the two runs. But we can do better.
Reading just 200 rows is the theoretical optimum. We can't quite hit it (in MySQL), but we can
get close. We read 400 rows, sort them, and take the top 200. That's much better
than sorting all 125,000 matching rows.

## The fix

If the engine won't merge the runs for us, we can at least cap the work
ourselves. Every row in the global top 200 is also in the top 200 of its own
run, because a row can't be among the 200 newest overall without being among the
200 newest for its user. In short, the union of the per-user top 200s already contains
the whole answer, and that union is at most 400 rows. That's it! We've found a way
to beat the optimizer, reading a few hundred rows where it scanned two million.
This is how we'll shape the rewrite. We query each value on its own, each with its
own limit, then combine the results.

```sql
SELECT * FROM (
  (SELECT * FROM activities
     WHERE account_id = 1 AND creator_id = 1
     ORDER BY id DESC LIMIT 200)
  UNION ALL
  (SELECT * FROM activities
     WHERE account_id = 1 AND creator_id = 2
     ORDER BY id DESC LIMIT 200)
) AS activities
ORDER BY id DESC LIMIT 200
```

Each branch now filters on a single user, so the composite index is fully
usable. MySQL walks `(account_id, creator_id, id)` backward for that user and
stops after 200 rows, with no sort inside the branch. The outer query then orders
at most `branches × 200` rows, which is, in this case, negligible. We're basically
doing the optimizer's work by telling MySQL to stop reading after 200 matches per branch.

That per-branch `LIMIT` is crucial. Without it, each branch returns every row for its
user. MySQL reads all 125,000 into a sort again, exactly the plan we were trying to
escape. So, the limit has to sit inside each branch, not only on the outer query.

The plan confirms it:

```
-> Limit: 200 row(s)
     (actual time=6.42..6.49 rows=200)
  -> Sort: activities.id DESC, limit input to 200 row(s) per chunk
       (actual time=6.42..6.45 rows=200)
    -> Table scan on activities
         (actual time=6.12..6.25 rows=400)
      -> Union all materialize
           (actual time=6.12..6.12 rows=400)
        -> Limit: 200 row(s)
             (actual time=2.55..2.67 rows=200)
          -> Index lookup on activities using idx_account_creator
             (account_id=1, creator_id=1) (reverse)
               (rows=128788) (actual time=2.55..2.64 rows=200)
        -> Limit: 200 row(s)
             (actual time=3.03..3.14 rows=200)
          -> Index lookup on activities using idx_account_creator
             (account_id=1, creator_id=2) (reverse)
               (rows=8998) (actual time=3.03..3.14 rows=200)
```

## Pagination

Offset pagination adds a subtlety. If the request is the third page of 200, we
need rows 401 to 600 in the global order. In the worst case all 400 rows before
them come from a single branch, so the per-branch limit has to be
`page_number × page_size`, not just `page_size`. The rewrite still holds, but its
cost now grows linearly with page depth.

Cursor pagination resolves this problem. When the client passes the last `id` it's
seen (`filter[before_id]=X`), each branch keeps a constant limit of `page_size`,
because the cursor decides where to resume.

## The Postgres equivalent

If we hand Postgres the same UNION ALL rewrite, its planner reaches for an operator
MySQL doesn't have, *Merge Append*:

```
Limit  (actual time=0.78..1.09 rows=200)
  -> Merge Append  (actual time=0.77..1.05 rows=200)
       Sort Key: id DESC
       -> Limit  (actual rows=192)
            -> Index Scan Backward using idx_account_creator (actual rows=192)
                 Index Cond: ((account_id = 1) AND (creator_id = 1))
       -> Limit  (actual rows=9)
            -> Index Scan Backward using idx_account_creator (actual rows=9)
                 Index Cond: ((account_id = 1) AND (creator_id = 2))
Execution Time: 1.228 ms
```

Merge Append is a true streaming merge. We can see that in the counts: 192 rows from
one branch, 9 from the other, 201 in total, not 400. It's the theoretical optimum
MySQL couldn't quite reach. It pulled from each run only as far as the merge needed.

## Takeaway

A single index can do both jobs this query needs, finding the matching rows and
returning them in order. But it only does both at once if the query is structured
to let it.

So when a query looks like it should be fast from the indexes alone and isn't,
check whether the `ORDER BY`, `LIMIT` and multi-value filter together are forcing
the engine to read and sort far more than the limit. If they are, rewriting it
as a UNION ALL of per-value branches, each with its own limit, can cut that wasted
work down to almost nothing.
