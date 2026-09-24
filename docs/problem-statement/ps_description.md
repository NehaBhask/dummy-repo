## The challenge
A booking and inventory service that never oversells under concurrency. It supports availability search with a TTL hold (a temporary reservation), confirmation with payment or release on timeout, and guarantees no overbooking even under many simultaneous requests for the same room/seat. The booking API must be idempotent (a retried request never double-books), multi-item bookings use a saga with compensation on partial failure, and cancellations restock inventory. This is a systems problem: correctness under concurrency, proven — the standout deliverable is a load test that shows zero oversell.

## What you need to build
Availability search with a TTL hold.
Confirm with payment; release the hold on timeout.
No overbooking under concurrent requests for the same inventory.
Idempotent booking API.
Multi-item saga with compensation on partial failure.
Cancellation with restock; localized currency.
Example scenario
As the platform, when 500 people race for the last 3 rooms, exactly 3 succeed, retries never double-book, and a failed multi-item booking rolls back cleanly.

## What a complete solution looks like
A booking service with inventory holds, confirm/timeout and concurrency safety — proven by a load test showing no oversell — plus an idempotent booking API.