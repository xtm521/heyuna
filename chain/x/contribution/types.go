// SPDX-License-Identifier: Apache-2.0
package contribution

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"
)

const (
	ModuleName                    = "contribution"
	ProtocolVersion               = 1
	ChallengePeriodSeconds int64  = 72 * 60 * 60
	WeekSeconds            int64  = 7 * 24 * 60 * 60
	ReleaseWeeks           uint64 = 520
	MaxPayloadBytes               = 48 * 1024
	MaxEpochEntries               = 128
)

// Config is immutable after genesis. NetworkDomain commits to the genesis
// context, while a separately distributed NetworkManifest pins the full genesis
// file hash (embedding that file's own hash in genesis would be circular).
type Config struct {
	Version           uint32   `json:"version"`
	ChainID           string   `json:"chain_id"`
	EVMChainID        uint64   `json:"evm_chain_id"`
	NetworkDomain     string   `json:"network_domain"`
	VaultAddress      string   `json:"vault_address"`
	Verifiers         []string `json:"verifiers"`
	StartTime         int64    `json:"start_time"`
	ChallengeSeconds  int64    `json:"challenge_period_seconds"`
	UnsafeTestProfile bool     `json:"unsafe_test_profile"`
}

func (c Config) Validate() error {
	if c.Version != ProtocolVersion || c.StartTime <= 0 || !hashOK(c.NetworkDomain) || !addressOK(c.VaultAddress) {
		return errors.New("invalid contribution genesis domain")
	}
	if c.UnsafeTestProfile {
		if c.ChainID != "heyuna_297012-1" || c.EVMChainID != 297012 || c.ChallengeSeconds != 3 {
			return errors.New("accelerated profile is restricted to its own chain domain")
		}
	} else if c.ChainID != "heyuna_297011-1" || c.EVMChainID != 297011 || c.ChallengeSeconds != ChallengePeriodSeconds {
		return errors.New("research network requires the fixed 72-hour challenge period")
	}
	if len(c.Verifiers) != 3 {
		return errors.New("exactly three invited verifiers required")
	}
	seen := map[common.Address]bool{}
	for _, v := range c.Verifiers {
		if !addressOK(v) || seen[common.HexToAddress(v)] {
			return errors.New("verifiers must be distinct nonzero EVM addresses")
		}
		seen[common.HexToAddress(v)] = true
	}
	return nil
}

type Envelope struct {
	Version       uint32          `json:"version"`
	ChainID       string          `json:"chain_id"`
	NetworkDomain string          `json:"network_domain"`
	VaultAddress  string          `json:"vault_address"`
	Kind          string          `json:"kind"`
	Body          json.RawMessage `json:"body"`
}

// Task binds the exact model, dataset, reviewed template, configuration, round,
// recipient and reward category. The SDK authenticated submitter is included in
// the task commitment; result hashes alone do not prove that training occurred.
type Task struct {
	ID                 string `json:"id"`
	Submitter          string `json:"submitter"`
	ModelHash          string `json:"model_hash"`
	DataHash           string `json:"data_hash"`
	TemplateHash       string `json:"template_hash"`
	ConfigHash         string `json:"config_hash"`
	Round              uint64 `json:"round"`
	Recipient          string `json:"recipient"`
	Category           uint8  `json:"category"`
	Nonce              uint64 `json:"nonce"`
	VerificationTarget string `json:"verification_target,omitempty"`
}

type SubmitTask struct {
	ModelHash          string `json:"model_hash"`
	DataHash           string `json:"data_hash"`
	TemplateHash       string `json:"template_hash"`
	ConfigHash         string `json:"config_hash"`
	Round              uint64 `json:"round"`
	Recipient          string `json:"recipient"`
	Category           uint8  `json:"category"`
	Nonce              uint64 `json:"nonce"`
	VerificationTarget string `json:"verification_target,omitempty"`
}

type Report struct {
	Verifier   string `json:"verifier"`
	ReportHash string `json:"report_hash"`
	Accept     bool   `json:"accept"`
}
type Receipt struct {
	ID                 string   `json:"id"`
	TaskID             string   `json:"task_id"`
	ResultHash         string   `json:"result_hash"`
	Submitter          string   `json:"submitter"`
	Recipient          string   `json:"recipient"`
	Category           uint8    `json:"category"`
	Reports            []Report `json:"reports"`
	Allocated          bool     `json:"allocated"`
	AllocatedEpoch     uint64   `json:"allocated_epoch"`
	VerificationTarget string   `json:"verification_target,omitempty"`
	ArtifactHash       string   `json:"artifact_hash,omitempty"`
	EvidenceHash       string   `json:"evidence_hash,omitempty"`
}
type SubmitResult struct {
	TaskID             string `json:"task_id"`
	ResultHash         string `json:"result_hash,omitempty"`
	VerificationTarget string `json:"verification_target,omitempty"`
	ArtifactHash       string `json:"artifact_hash,omitempty"`
	EvidenceHash       string `json:"evidence_hash,omitempty"`
}
type SubmitReport struct {
	ReceiptID  string `json:"receipt_id"`
	ReportHash string `json:"report_hash"`
	Accept     bool   `json:"accept"`
}
type Entry struct {
	Index     uint32 `json:"index"`
	ReceiptID string `json:"receipt_id"`
	Category  uint8  `json:"category"`
	Amount    string `json:"amount"`
	Recipient string `json:"recipient"`
}
type ProposeEpoch struct {
	Epoch   uint64  `json:"epoch"`
	Nonce   uint64  `json:"nonce"`
	Entries []Entry `json:"entries"`
}
type ControlEpoch struct {
	Epoch uint64 `json:"epoch"`
	Nonce uint64 `json:"nonce"`
}
type EpochRef struct {
	Epoch uint64 `json:"epoch"`
}
type ChallengeInput struct {
	Epoch        uint64 `json:"epoch"`
	EvidenceHash string `json:"evidence_hash"`
}
type Challenge struct {
	ID           string `json:"id"`
	Epoch        uint64 `json:"epoch"`
	Challenger   string `json:"challenger"`
	EvidenceHash string `json:"evidence_hash"`
	RegisteredAt int64  `json:"registered_at"`
}

type ControlVote struct {
	Verifier string `json:"verifier"`
	Action   string `json:"action"`
}
type Epoch struct {
	ID                 uint64        `json:"id"`
	Root               string        `json:"root"`
	TrainingBudget     string        `json:"training_budget"`
	VerificationBudget string        `json:"verification_budget"`
	Entries            []Entry       `json:"entries"`
	ProposalHash       string        `json:"proposal_hash"`
	ProposalNonce      uint64        `json:"proposal_nonce"`
	Approvals          []string      `json:"approvals"`
	Status             string        `json:"status"` // voting, pending, frozen, cancelled, finalized
	ProposedAt         int64         `json:"proposed_at"`
	FinalizeAfter      int64         `json:"finalize_after"`
	ControlNonce       uint64        `json:"control_nonce"`
	ControlVotes       []ControlVote `json:"control_votes"`
}
type Accounting struct {
	TrainingReserved     string `json:"training_reserved"`
	VerificationReserved string `json:"verification_reserved"`
}
type Record struct {
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`
}
type GenesisState struct {
	Config  Config   `json:"config"`
	Records []Record `json:"records,omitempty"`
}

func hashOK(s string) bool {
	if len(s) != 66 || !strings.HasPrefix(s, "0x") {
		return false
	}
	b, err := hex.DecodeString(s[2:])
	if err != nil {
		return false
	}
	return !bytes.Equal(b, make([]byte, 32))
}
func addressOK(s string) bool {
	return common.IsHexAddress(s) && common.HexToAddress(s) != (common.Address{})
}
func canonicalHash(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return "0x" + hex.EncodeToString(h[:])
}
func NormalizeHash(s string) string { return strings.ToLower(s) }
func strictDecode(data []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return err
	}
	var trailing any
	if err := d.Decode(&trailing); err != io.EOF {
		return errors.New("trailing JSON input")
	}
	return nil
}
func amount(s string) (*big.Int, error) {
	if s == "" || len(s) > 78 || (len(s) > 1 && s[0] == '0') {
		return nil, errors.New("invalid canonical integer amount")
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return nil, errors.New("amount must be unsigned decimal")
		}
	}
	v, ok := new(big.Int).SetString(s, 10)
	if !ok || v.BitLen() > 256 {
		return nil, errors.New("amount exceeds uint256")
	}
	return v, nil
}
func TrainingCap() *big.Int {
	return new(big.Int).Mul(big.NewInt(12_600_000), new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))
}
func VerificationCap() *big.Int {
	return new(big.Int).Mul(big.NewInt(1_400_000), new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))
}
func TotalCap() *big.Int { return new(big.Int).Add(TrainingCap(), VerificationCap()) }

// WeeklyBudget uses integer differences for the first 520 weeks. Unallocated
// funds remain in the vault; later weeks retain the original single-week cap.
func WeeklyBudget(epoch uint64) (training, verification *big.Int) {
	total := TotalCap()
	weeks := new(big.Int).SetUint64(ReleaseWeeks)
	var budget *big.Int
	if epoch < ReleaseWeeks {
		b := new(big.Int).Div(new(big.Int).Mul(total, new(big.Int).SetUint64(epoch+1)), weeks)
		a := new(big.Int).Div(new(big.Int).Mul(total, new(big.Int).SetUint64(epoch)), weeks)
		budget = new(big.Int).Sub(b, a)
	} else {
		budget = new(big.Int).Div(new(big.Int).Add(total, new(big.Int).Sub(weeks, big.NewInt(1))), weeks)
	}
	training = new(big.Int).Div(new(big.Int).Mul(budget, big.NewInt(90)), big.NewInt(100))
	verification = new(big.Int).Sub(budget, training)
	return
}

func validateEntry(e Entry) error {
	if e.Category > 1 || !hashOK(e.ReceiptID) || !addressOK(e.Recipient) {
		return errors.New("invalid reward entry")
	}
	a, err := amount(e.Amount)
	if err != nil || a.Sign() <= 0 {
		return fmt.Errorf("reward amount must be positive uint256")
	}
	return nil
}
