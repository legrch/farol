package process

// Selection exposes immutable correlation to the Task Host constructor only.
// It is neither current admission nor native/CLI qualification evidence.
func (c *Client) Selection() Selection {
	if c == nil {
		return Selection{}
	}
	return c.selected
}
