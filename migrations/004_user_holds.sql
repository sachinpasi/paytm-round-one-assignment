-- seats each user currently holds per show; the per-user limit is enforced on this row
CREATE TABLE user_holds (
    show_id    text NOT NULL REFERENCES shows (id),
    user_id    text NOT NULL,
    seat_count int  NOT NULL CHECK (seat_count >= 0),
    PRIMARY KEY (show_id, user_id)
);
