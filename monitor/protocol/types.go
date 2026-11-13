package protocol

import "encoding/json"

type Discovery struct {
	IP         string `json:"ip"`
	Provider   string `json:"provider"`
	Region     string `json:"region"`
	Country    string `json:"country"`
	City       string `json:"city"`
	Timezone   string `json:"timezone"`
	ASN        string `json:"asn"`
	Source     string `json:"source"`
	DetectedAt int64  `json:"detectedAt"`
}

type Asset struct {
	Provider        string  `json:"provider"`
	Region          string  `json:"region"`
	ExpiresAt       string  `json:"expiresAt"`
	Price           float64 `json:"price"`
	Currency        string  `json:"currency"`
	BillingCycle    string  `json:"billingCycle"`
	VendorURL       string  `json:"vendorUrl"`
	AutoPay         bool    `json:"autoPay"`
	TrafficLimit    uint64  `json:"trafficLimit"`
	TrafficMode     string  `json:"trafficMode"`
	ResetDay        int     `json:"resetDay"`
	Timezone        string  `json:"timezone"`
	InitialUpload   uint64  `json:"initialUpload"`
	InitialDownload uint64  `json:"initialDownload"`
	InitialPeriod   string  `json:"initialPeriod"`
}
type Node struct {
	ProbeRequestID  string          `json:"probeRequestId,omitempty"`
	OwnerID         string          `json:"-"`
	IntervalSeconds int             `json:"intervalSeconds,omitempty"`
	TodayUpload     uint64          `json:"todayUpload"`
	TodayDownload   uint64          `json:"todayDownload"`
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	Group           string          `json:"group"`
	Asset           Asset           `json:"asset"`
	LastSeen        int64           `json:"lastSeen"`
	Metrics         json.RawMessage `json:"metrics,omitempty"`
	Upload          uint64          `json:"upload"`
	Download        uint64          `json:"download"`
	PeriodUpload    uint64          `json:"periodUpload"`
	PeriodDownload  uint64          `json:"periodDownload"`
	PeriodStart     int64           `json:"periodStart"`
	PeriodEnd       int64           `json:"periodEnd"`
	CoverageStart   int64           `json:"coverageStart"`
	Incomplete      bool            `json:"incomplete"`
}
type Report struct {
	Epoch      string          `json:"epoch"`
	Sequence   uint64          `json:"sequence"`
	Timestamp  int64           `json:"timestamp"`
	Upload     uint64          `json:"upload"`
	Download   uint64          `json:"download"`
	Incomplete bool            `json:"incomplete"`
	Metrics    json.RawMessage `json:"metrics"`
}
type Point struct {
	Timestamp  int64           `json:"timestamp"`
	Metrics    json.RawMessage `json:"metrics"`
	Upload     uint64          `json:"upload"`
	Download   uint64          `json:"download"`
	Incomplete bool            `json:"incomplete"`
}
type Alert struct {
	ID        int64  `json:"id"`
	NodeID    string `json:"nodeId"`
	Kind      string `json:"kind"`
	Message   string `json:"message"`
	Timestamp int64  `json:"timestamp"`
	Delivered bool   `json:"delivered"`
}
