# Game day summary

Each cell is the median with the range (min-max) over the runs in brackets. Time to page counts only runs that paged.

| drill | label | runs | paged | time to page | first page | time to ticket | time to recover | impact | peak backlog |
|---|---|---|---|---|---|---|---|---|---|
| poison-event | baseline | 5 | 5/5 | 617.9s (615.2-620.4) | RailcarPositionsStale x5 | 318.2s (315.5-320.6) | 35.3s (32.7-37.9) | 655.4s (650.1-656.3) | 15811 (15759-15886) |
| postgres-latency | baseline | 5 | 0/5 | - | none x5 | 928.7s (924.4-932.2) | 37.4s (36.5-38.8) | 1237.6s (1236.7-1239) | 19230 (19201-19263) |
| postgres-stop | baseline | 5 | 5/5 | 376s (361-381.3) | QueryErrorRateHigh x5 | 320.5s (319.7-325.2) | 35.7s (25.4-41.6) | 402.5s (401.9-423.9) | 9741 (9741-10251) |
| tracker-stop | baseline | 5 | 5/5 | 319.4s (316.1-324.7) | ServiceDown x5 | - | 19.9s (19-23.1) | 339.9s (337.2-348.6) | 8184 (8058-8312) |
