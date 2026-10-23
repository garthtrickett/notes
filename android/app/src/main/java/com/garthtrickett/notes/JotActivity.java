package com.garthtrickett.notes;

// Separate activity identity keeps a saved Lookup draft from being reused
// when the user taps Note down (or vice versa). Both use the same durable inbox.
public class JotActivity extends LookupActivity {
    @Override protected boolean jottedDown() { return true; }
}
