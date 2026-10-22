# Game day summary

Each cell is the median with the range (min-max) over the runs in brackets. Time to page counts only runs that paged.

| drill | label | runs | paged | time to page | first page | time to ticket | time to recover | impact | peak backlog |
|---|---|---|---|---|---|---|---|---|---|
| poison-event | baseline | 5 | 5/5 | 617.9s (615.2-620.4) | RailcarPositionsStale x5 | 318.2s (315.5-320.6) | 35.3s (32.7-37.9) | 655.4s (650.1-656.3) | 15811 (15759-15886) |
| poison-event | dead-letter | 5 | 0/5 | - | none x5 | 19.6s (16.8-20.8) | 0.4s (0.1-0.5) | 301.9s (301.5-302) | 0 (0-0) |
| poison-event | new-alerts | 5 | 5/5 | 137.3s (131.9-137.9) | RailcarEventsDelayed x5 | 137.3s (131.9-137.9) | 13s (12.3-13.7) | 150.6s (145.9-151.1) | 3596 (3468-3646) |
| postgres-latency | baseline | 5 | 0/5 | - | none x5 | 928.7s (924.4-932.2) | 37.4s (36.5-38.8) | 1237.6s (1236.7-1239) | 19230 (19201-19263) |
| postgres-latency | new-alerts | 5 | 5/5 | 173.7s (173.6-174.1) | RailcarEventsDelayed x5 | - | 5.6s (5.5-6.1) | 180.2s (179.5-180.8) | 2779 (2775-2796) |
| postgres-stop | baseline | 5 | 5/5 | 376s (361-381.3) | QueryErrorRateHigh x5 | 320.5s (319.7-325.2) | 35.7s (25.4-41.6) | 402.5s (401.9-423.9) | 9741 (9741-10251) |
| postgres-stop | new-alerts | 5 | 5/5 | 139.6s (136.7-140.4) | RailcarEventsDelayed x5 | 144.6s (141.7-145.4) | 10.9s (9.4-13.7) | 150.6s (150.5-151.1) | 3569 (3544-3621) |
| tracker-stop | baseline | 5 | 5/5 | 319.4s (316.1-324.7) | ServiceDown x5 | - | 19.9s (19-23.1) | 339.9s (337.2-348.6) | 8184 (8058-8312) |
| tracker-stop | new-alerts | 5 | 5/5 | 138.9s (138.6-141.2) | RailcarEventsDelayed x5 | - | 10.7s (10.4-10.9) | 150.2s (149.6-152.6) | 3517 (3517-3569) |
