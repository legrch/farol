// Package planresponses implements the restricted public SIWC Responses transport.
// It does not refresh credentials, supply API keys, retry inference or run tools.
package planresponses

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/services/inference"
)

const Endpoint = "https://api.openai.com/v1/responses"

const (
	HTTPRejected       inference.Code = "INFERENCE_HTTP_REJECTED"
	ModelDenied        inference.Code = "INFERENCE_MODEL_DENIED"
	UsageLimited       inference.Code = "INFERENCE_USAGE_LIMITED"
	CredentialRejected inference.Code = "INFERENCE_CREDENTIAL_REJECTED"
	TransportUnknown   inference.Code = "INFERENCE_TRANSPORT_UNKNOWN"
	StreamInvalid      inference.Code = "INFERENCE_STREAM_INVALID"
	StreamLimit        inference.Code = "INFERENCE_STREAM_LIMIT"
	StreamIncomplete   inference.Code = "INFERENCE_STREAM_INCOMPLETE"
	ProviderFailed     inference.Code = "INFERENCE_PROVIDER_FAILED"
	ProviderRefused    inference.Code = "INFERENCE_PROVIDER_REFUSED"
)

type Client struct{ http http.Client }

var _ inference.Transport = (*Client)(nil)

// New clones the caller's HTTP configuration. The endpoint and redirect refusal
// are fixed even when a controlled RoundTripper is injected for source tests.
func New(client *http.Client) *Client {
	var copied http.Client
	if client != nil {
		copied = *client
	}
	copied.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{http: copied}
}

func (c *Client) Infer(ctx context.Context, credential inference.Credential, request inference.Request) inference.Outcome {
	if ctx == nil || c == nil {
		return refused(inference.Invalid)
	}
	if ctx.Err() != nil {
		return refused(inference.Cancelled)
	}
	if request.DeadlineMillis == 0 || request.DeadlineMillis > math.MaxInt64 {
		return refused(inference.Invalid)
	}
	deadline := time.UnixMilli(int64(request.DeadlineMillis))
	if !time.Now().Before(deadline) {
		return refused(inference.Cancelled)
	}
	ctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	if !validToken(credential.AccessToken) {
		return refused(inference.CredentialUnavailable)
	}
	body, ok := requestBody(request)
	if !ok {
		return refused(inference.Invalid)
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, Endpoint, bytes.NewReader(body))
	if err != nil {
		return refused(inference.Invalid)
	}
	httpRequest.Header.Set("Authorization", "Bearer "+credential.AccessToken)
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Accept", "text/event-stream")
	// This is the last known pre-I/O refusal point. Any error from Do is unknown,
	// including cancellation: neither proves absence of a possible remote effect.
	if ctx.Err() != nil {
		return refused(inference.Cancelled)
	}
	// Keep refusal effective for an exported Client's zero value as well.
	httpClient := c.http
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := httpClient.Do(httpRequest)
	if err != nil {
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		return uncertain(TransportUnknown, "")
	}
	if response == nil || response.Body == nil {
		return uncertain(TransportUnknown, "")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		out := inference.Outcome{State: inference.Failed, Code: rejectedCode(response.StatusCode), HTTPStatus: response.StatusCode}
		// Only fixed categories survive; a rejected request is never reissued.
		raw, readErr := io.ReadAll(io.LimitReader(response.Body, MaxFrameBytes+1))
		if readErr == nil && len(raw) <= MaxFrameBytes && validJSON(raw) {
			var failure struct {
				Error struct {
					Code  string `json:"code"`
					Param string `json:"param"`
				} `json:"error"`
			}
			if json.Unmarshal(raw, &failure) == nil {
				out.Code = safeFailure(failure.Error.Code, failure.Error.Param, out.Code)
			}
		}
		return out
	}
	media, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || media != "text/event-stream" {
		out := uncertain(StreamInvalid, "")
		out.HTTPStatus = response.StatusCode
		return out
	}
	out := consume(ctx, response.Body)
	out.HTTPStatus = response.StatusCode
	return out
}

func refused(code inference.Code) inference.Outcome {
	return inference.Outcome{State: inference.NotSent, Code: code}
}
func uncertain(code inference.Code, id string) inference.Outcome {
	return inference.Outcome{State: inference.Unknown, ResponseID: id, Code: code}
}

func validToken(token string) bool {
	if len(token) == 0 || len(token) > 16<<10 || strings.HasPrefix(token, "sk-") {
		return false
	}
	for _, b := range []byte(token) {
		if b < 33 || b > 126 {
			return false
		}
	}
	return true
}

func identifier(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, r := range value {
		if r < 'A' || r > 'Z' {
			if r < 'a' || r > 'z' {
				if r < '0' || r > '9' {
					if r != '_' && r != '-' && r != '.' {
						return false
					}
				}
			}
		}
	}
	return true
}

func requestBody(request inference.Request) ([]byte, bool) {
	if inference.ValidateRequest(request) != nil {
		return nil, false
	}
	if !identifier(request.Model.Slug) || len(request.Input) == 0 || len(request.Input) > inference.MaxInputItems {
		return nil, false
	}
	if request.Model.Effort != "" {
		if strings.TrimSpace(request.Model.CapabilityEvidence) == "" || len(request.Model.CapabilityEvidence) > 256 || !utf8.ValidString(request.Model.CapabilityEvidence) {
			return nil, false
		}
		switch request.Model.Effort {
		case "none", "minimal", "low", "medium", "high", "xhigh":
		default:
			return nil, false
		}
	}
	items := make([]any, 0, len(request.Input))
	inputBytes := 0
	calls := make(map[string]bool)
	for _, item := range request.Input {
		for _, text := range []string{item.Content, item.Arguments, item.Name, item.CallID} {
			if !utf8.ValidString(text) {
				return nil, false
			}
			inputBytes += len(text)
		}
		if inputBytes > inference.MaxInputBytes {
			return nil, false
		}
		switch item.Kind {
		case "message":
			if item.Role != "user" && item.Role != "assistant" && item.Role != "developer" || item.CallID != "" || item.Name != "" || item.Arguments != "" {
				return nil, false
			}
			items = append(items, struct {
				Type    string `json:"type"`
				Role    string `json:"role"`
				Content string `json:"content"`
			}{"message", item.Role, item.Content})
		case "function_call":
			if !identifier(item.CallID) || !identifier(item.Name) || item.Role != "" || item.Content != "" || !validJSON([]byte(item.Arguments)) {
				return nil, false
			}
			if _, exists := calls[item.CallID]; exists {
				return nil, false
			}
			calls[item.CallID] = false
			items = append(items, struct {
				Type      string `json:"type"`
				CallID    string `json:"call_id"`
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			}{"function_call", item.CallID, item.Name, item.Arguments})
		case "function_call_output":
			if !identifier(item.CallID) || item.Role != "" || item.Name != "" || item.Arguments != "" {
				return nil, false
			}
			if closed, exists := calls[item.CallID]; !exists || closed {
				return nil, false
			}
			calls[item.CallID] = true
			items = append(items, struct {
				Type   string `json:"type"`
				CallID string `json:"call_id"`
				Output string `json:"output"`
			}{"function_call_output", item.CallID, item.Content})
		default:
			return nil, false
		}
	}
	for _, closed := range calls {
		if !closed {
			return nil, false
		}
	}
	payload := struct {
		Model     string `json:"model"`
		Input     []any  `json:"input"`
		Store     bool   `json:"store"`
		Stream    bool   `json:"stream"`
		Reasoning *struct {
			Effort string `json:"effort"`
		} `json:"reasoning,omitempty"`
	}{Model: request.Model.Slug, Input: items, Stream: true}
	if request.Model.Effort != "" {
		payload.Reasoning = &struct {
			Effort string `json:"effort"`
		}{request.Model.Effort}
	}
	raw, err := json.Marshal(payload)
	return raw, err == nil && len(raw) <= inference.MaxInputBytes
}

func rejectedCode(status int) inference.Code {
	switch status {
	case 401:
		return CredentialRejected
	case 429:
		return UsageLimited
	default:
		return HTTPRejected
	}
}

func safeFailure(code, param string, fallback inference.Code) inference.Code {
	switch code {
	case "model_not_found", "model_not_allowed", "model_access_denied":
		return ModelDenied
	case "subscription_sharing_usage_limit_exceeded", "rate_limit_exceeded", "insufficient_quota":
		return UsageLimited
	case "subscription_sharing_user_not_eligible", "subscription_sharing_invalid_user", "chatpass_v2_scope_not_authorized", "chatpass_v2_invalid_authorization_context":
		return CredentialRejected
	case "invalid_request_error":
		if param == "model" {
			return ModelDenied
		}
	}
	return fallback
}
