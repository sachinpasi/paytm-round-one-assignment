-- the primary key is what dedupes retries; request_hash catches a key reused for a different request
CREATE TABLE idempotency (
    user_id        text NOT NULL,
    key            text NOT NULL,
    request_hash   text NOT NULL,
    reservation_id text NOT NULL,
    PRIMARY KEY (user_id, key)
);
