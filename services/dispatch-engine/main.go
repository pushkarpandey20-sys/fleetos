// services/dispatch-engine/main.go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"os/signal"
	"sort"
	"syscall"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/oklog/ulid/v2"
	"github.com/segmentio/kafka-go"
)

// ─── Config ──────────────────────────────────────────────────────────
type Config struct {
	KafkaBrokers     string
	RedisAddr        string
	OSRMBaseURL      string
	InitialRadiusM   float64
	RadiusExpansion  float64
	MaxRetries       int
	AcceptanceSec    int
	MaxTasksPerRider int
}

func loadConfig() Config {
	return Config{
		KafkaBrokers:     getEnv("KAFKA_BROKERS", "localhost:9092"),
		RedisAddr:        getEnv("REDIS_ADDR", "localhost:6379"),
		OSRMBaseURL:      getEnv("OSRM_URL", "http://localhost:5000"),
		InitialRadiusM:   3000,
		RadiusExpansion:  1.5,
		MaxRetries:       3,
		AcceptanceSec:    45,
		MaxTasksPerRider: 12,
	}
}

// ─── Event Types ──────────────────────────────────────────────────────
type OrderCreatedEvent struct {
	EventID     string  `json:"event_id"`
	EventType   string  `json:"event_type"`
	ProducedAt  string  `json:"produced_at"`
	OrderID     string  `json:"order_id"`
	ClientID    string  `json:"client_id"`
	ZoneID      string  `json:"zone_id"`
	Pickup      GeoAddr `json:"pickup"`
	Dropoff     GeoAddr `json:"dropoff"`
	CODAmount   float64 `json:"cod_amount"`
	WeightKg    float64 `json:"weight_kg"`
	SLAMinutes  int     `json:"sla_minutes"`
	SLADeadline string  `json:"sla_deadline"`
	Retries     int     `json:"retries"`
	SearchRadius float64 `json:"search_radius"`
}

type GeoAddr struct {
	Lat     float64 `json:"lat"`
	Lng     float64 `json:"lng"`
	Address string  `json:"address"`
}

type RiderCandidate struct {
	RiderID      string
	Lat          float64
	Lng          float64
	Distance     float64
	PendingTasks int
	Rating       float64
	ZoneMatch    bool
	ShiftHours   float64
	Score        float64
}

type AssignmentPayload struct {
	EventID     string `json:"event_id"`
	EventType   string `json:"event_type"`
	ProducedAt  string `json:"produced_at"`
	OrderID     string `json:"order_id"`
	ClientID    string `json:"client_id"`
	RiderID     string `json:"rider_id"`
	ZoneID      string `json:"zone_id"`
	SLADeadline string `json:"sla_deadline"`
	ETASeconds  int    `json:"eta_seconds"`
}

type AutoAssignFailedEvent struct {
	EventID      string `json:"event_id"`
	EventType    string `json:"event_type"`
	ProducedAt   string `json:"produced_at"`
	OrderID      string `json:"order_id"`
	ClientID     string `json:"client_id"`
	ZoneID       string `json:"zone_id"`
	Retries      int    `json:"retries"`
	LastRadiusM  float64 `json:"last_radius_m"`
}

// ─── Weights ─────────────────────────────────────────────────────────
const (
	wDistance    = 0.40
	wPending     = 0.25
	wRating      = 0.15
	wZoneMatch   = 0.12
	wShiftHours  = 0.08
)

// ─── Dispatch Engine ──────────────────────────────────────────────────
type DispatchEngine struct {
	cfg    Config
	rdb    *redis.Client
	reader *kafka.Reader
	writer *kafka.Writer
}

func NewDispatchEngine(cfg Config) *DispatchEngine {
	rdb := redis.NewClient(&redis.Options{Addr: cfg.RedisAddr})

	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:   []string{cfg.KafkaBrokers},
		Topic:     "orders.created",
		GroupID:   "dispatch-engine",
		MinBytes:  1,
		MaxBytes:  10e6,
		MaxWait:   100 * time.Millisecond,
	})

	writer := &kafka.Writer{
		Addr:         kafka.TCP(cfg.KafkaBrokers),
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireOne,
	}

	return &DispatchEngine{cfg: cfg, rdb: rdb, reader: reader, writer: writer}
}

func (e *DispatchEngine) Run(ctx context.Context) {
	log.Println("[dispatch] engine started, consuming orders.created")
	for {
		msg, err := e.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil { return }
			log.Printf("[dispatch] fetch error: %v", err)
			continue
		}

		var event OrderCreatedEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("[dispatch] bad message: %v", err)
			e.reader.CommitMessages(ctx, msg)
			continue
		}

		if event.SearchRadius == 0 {
			event.SearchRadius = e.cfg.InitialRadiusM
		}

		go e.processOrder(ctx, event)
		e.reader.CommitMessages(ctx, msg)
	}
}

func (e *DispatchEngine) processOrder(ctx context.Context, event OrderCreatedEvent) {
	log.Printf("[dispatch] processing order=%s retries=%d radius=%.0fm",
		event.OrderID, event.Retries, event.SearchRadius)

	if event.Retries >= e.cfg.MaxRetries {
		log.Printf("[dispatch] max retries for order=%s — escalating", event.OrderID)
		e.publishAutoAssignFailed(ctx, event)
		return
	}

	// Find riders within radius
	candidates, err := e.findRiderCandidates(ctx, event)
	if err != nil {
		log.Printf("[dispatch] candidate query error: %v", err)
		return
	}

	if len(candidates) == 0 {
		log.Printf("[dispatch] no candidates for order=%s, expanding radius", event.OrderID)
		e.retryWithExpandedRadius(ctx, event)
		return
	}

	// Score and sort
	scored := e.scoreCandidates(candidates, event.ZoneID)
	top3 := scored[:min(3, len(scored))]

	// Validate ETA for each top candidate
	slaDeadline, _ := time.Parse(time.RFC3339, event.SLADeadline)
	windowSeconds := int(time.Until(slaDeadline).Seconds()) / 3 // pickup must be < 1/3 of SLA

	for _, c := range top3 {
		eta, err := e.computeOSRMEta(c.Lat, c.Lng, event.Pickup.Lat, event.Pickup.Lng)
		if err != nil {
			log.Printf("[dispatch] OSRM error for rider=%s: %v", c.RiderID, err)
			continue
		}

		if eta <= windowSeconds {
			// Found a valid rider — assign
			e.assignRider(ctx, event, c, eta)
			return
		}
		log.Printf("[dispatch] rider=%s ETA=%ds > window=%ds, skipping", c.RiderID, eta, windowSeconds)
	}

	// No valid ETA found — expand radius
	e.retryWithExpandedRadius(ctx, event)
}

func (e *DispatchEngine) findRiderCandidates(ctx context.Context, event OrderCreatedEvent) ([]RiderCandidate, error) {
	// Query Redis GeoRadius for available riders near pickup
	locations, err := e.rdb.GeoRadius(ctx, "riders:geo",
		event.Pickup.Lng, event.Pickup.Lat,
		&redis.GeoRadiusQuery{
			Radius:      event.SearchRadius,
			Unit:        "m",
			WithCoord:   true,
			WithDist:    true,
			Count:       20,
			Sort:        "ASC",
		},
	).Result()
	if err != nil {
		return nil, err
	}

	var candidates []RiderCandidate
	for _, loc := range locations {
		// Get rider details from Redis hash
		riderData, err := e.rdb.HGetAll(ctx, fmt.Sprintf("rider:%s", loc.Name)).Result()
		if err != nil || riderData["status"] != "available" {
			continue
		}

		pendingTasks := 0
		fmt.Sscanf(riderData["pending_tasks"], "%d", &pendingTasks)
		if pendingTasks >= e.cfg.MaxTasksPerRider {
			continue
		}

		rating := 5.0
		fmt.Sscanf(riderData["rating"], "%f", &rating)

		shiftHours := 0.0
		if shiftStart, ok := riderData["shift_start"]; ok {
			t, _ := time.Parse(time.RFC3339, shiftStart)
			shiftHours = time.Since(t).Hours()
		}

		candidates = append(candidates, RiderCandidate{
			RiderID:      loc.Name,
			Lat:          loc.GeoPos.Latitude,
			Lng:          loc.GeoPos.Longitude,
			Distance:     loc.Dist,
			PendingTasks: pendingTasks,
			Rating:       rating,
			ZoneMatch:    riderData["zone_id"] == event.ZoneID,
			ShiftHours:   shiftHours,
		})
	}
	return candidates, nil
}

func (e *DispatchEngine) scoreCandidates(candidates []RiderCandidate, zoneID string) []RiderCandidate {
	for i := range candidates {
		c := &candidates[i]
		distScore := 1.0 / math.Max(c.Distance, 1)
		pendingScore := 1.0 / math.Max(float64(c.PendingTasks+1), 1)
		ratingScore := c.Rating / 5.0
		zoneScore := 0.0
		if c.ZoneMatch { zoneScore = 1.0 }
		shiftScore := 1.0 / math.Max(c.ShiftHours+1, 1)

		c.Score = wDistance*distScore +
			wPending*pendingScore +
			wRating*ratingScore +
			wZoneMatch*zoneScore +
			wShiftHours*shiftScore
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].Score > candidates[j].Score
	})
	return candidates
}

func (e *DispatchEngine) assignRider(ctx context.Context, event OrderCreatedEvent, rider RiderCandidate, eta int) {
	log.Printf("[dispatch] assigning order=%s to rider=%s (score=%.4f eta=%ds)",
		event.OrderID, rider.RiderID, rider.Score, eta)

	// Atomically mark rider as busy and set order rider
	pipe := e.rdb.Pipeline()
	pipe.HSet(ctx, fmt.Sprintf("rider:%s", rider.RiderID), "status", "busy")
	pipe.HIncrBy(ctx, fmt.Sprintf("rider:%s", rider.RiderID), "pending_tasks", 1)
	pipe.LPush(ctx, fmt.Sprintf("rider:%s:tasks", rider.RiderID), event.OrderID)
	_, err := pipe.Exec(ctx)
	if err != nil {
		log.Printf("[dispatch] redis assign error: %v", err)
		return
	}

	payload := AssignmentPayload{
		EventID:     ulid.Make().String(),
		EventType:   "order.assigned",
		ProducedAt:  time.Now().UTC().Format(time.RFC3339),
		OrderID:     event.OrderID,
		ClientID:    event.ClientID,
		RiderID:     rider.RiderID,
		ZoneID:      event.ZoneID,
		SLADeadline: event.SLADeadline,
		ETASeconds:  eta,
	}

	data, _ := json.Marshal(payload)
	e.writer.WriteMessages(ctx, kafka.Message{
		Topic: "orders.assigned",
		Key:   []byte(rider.RiderID),
		Value: data,
	})
}

func (e *DispatchEngine) retryWithExpandedRadius(ctx context.Context, event OrderCreatedEvent) {
	event.Retries++
	event.SearchRadius *= e.cfg.RadiusExpansion
	log.Printf("[dispatch] retry %d for order=%s, new radius=%.0fm",
		event.Retries, event.OrderID, event.SearchRadius)

	// Re-publish with small delay
	time.Sleep(2 * time.Second)
	data, _ := json.Marshal(event)
	e.writer.WriteMessages(ctx, kafka.Message{
		Topic: "orders.created",
		Key:   []byte(event.ZoneID),
		Value: data,
	})
}

func (e *DispatchEngine) publishAutoAssignFailed(ctx context.Context, event OrderCreatedEvent) {
	payload := AutoAssignFailedEvent{
		EventID:     ulid.Make().String(),
		EventType:   "exception.auto_assign_failed",
		ProducedAt:  time.Now().UTC().Format(time.RFC3339),
		OrderID:     event.OrderID,
		ClientID:    event.ClientID,
		ZoneID:      event.ZoneID,
		Retries:     event.Retries,
		LastRadiusM: event.SearchRadius,
	}
	data, _ := json.Marshal(payload)
	e.writer.WriteMessages(ctx, kafka.Message{
		Topic: "exceptions.auto_assign_failed",
		Key:   []byte(event.OrderID),
		Value: data,
	})
}

func (e *DispatchEngine) computeOSRMEta(fromLat, fromLng, toLat, toLng float64) (int, error) {
	// OSRM HTTP API call
	url := fmt.Sprintf("%s/route/v1/driving/%f,%f;%f,%f?overview=false",
		e.cfg.OSRMBaseURL, fromLng, fromLat, toLng, toLat)

	// In production use http.Get + parse JSON
	// Simplified: return distance-based estimate
	dist := haversineKm(fromLat, fromLng, toLat, toLng)
	avgSpeedKmh := 25.0
	etaSeconds := int((dist / avgSpeedKmh) * 3600)
	return etaSeconds, nil
}

func haversineKm(lat1, lng1, lat2, lng2 float64) float64 {
	const R = 6371.0
	dLat := (lat2 - lat1) * math.Pi / 180
	dLng := (lng2 - lng1) * math.Pi / 180
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
			math.Sin(dLng/2)*math.Sin(dLng/2)
	return R * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

func min(a, b int) int {
	if a < b { return a }
	return b
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" { return v }
	return fallback
}

func main() {
	cfg := loadConfig()
	engine := NewDispatchEngine(cfg)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

	go engine.Run(ctx)
	log.Println("[dispatch] FleetOS Dispatch Engine running")

	<-sig
	log.Println("[dispatch] shutting down gracefully")
	cancel()
}
