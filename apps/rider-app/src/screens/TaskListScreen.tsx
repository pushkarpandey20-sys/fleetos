// apps/rider-app/src/screens/TaskListScreen.tsx
import React, { useEffect, useCallback, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  RefreshControl, Alert, AppState,
} from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { fetchTasks, updateOrderStatus } from '../store/taskSlice';
import { syncOfflineQueue } from '../store/offlineSlice';
import { RootState } from '../store';
import { Task } from '../types';
import { formatDistanceKm } from '../utils/geo';
import { Colors, Typography, Spacing } from '../theme';

export default function TaskListScreen() {
  const navigation = useNavigation<any>();
  const dispatch = useDispatch<any>();
  const { tasks, loading } = useSelector((s: RootState) => s.tasks);
  const { queue: offlineQueue } = useSelector((s: RootState) => s.offline);
  const rider = useSelector((s: RootState) => s.auth.rider);
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      dispatch(fetchTasks());
      dispatch(syncOfflineQueue());
    }, [])
  );

  // Sync offline queue when app comes to foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        dispatch(syncOfflineQueue());
        dispatch(fetchTasks());
      }
    });
    return () => sub.remove();
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await dispatch(fetchTasks());
    await dispatch(syncOfflineQueue());
    setRefreshing(false);
  };

  const handleAcceptTask = async (task: Task) => {
    Alert.alert(
      'Accept delivery',
      `Order ${task.order_number}\n${task.drop_address}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Accept',
          onPress: async () => {
            await dispatch(updateOrderStatus({
              orderId: task.id,
              status: 'picked_up',
            }));
            navigation.navigate('Navigation', { task });
          },
        },
      ]
    );
  };

  const renderTask = ({ item: task, index }: { item: Task; index: number }) => {
    const isNext = index === 0;
    const borderColor = isNext ? Colors.blue : task.cod_amount > 0 ? Colors.amber : Colors.green;

    return (
      <TouchableOpacity
        style={[styles.taskCard, { borderLeftColor: borderColor }]}
        onPress={() => navigation.navigate('TaskDetail', { task })}
        activeOpacity={0.7}
      >
        <View style={styles.taskHeader}>
          <View style={styles.taskLeft}>
            <Text style={styles.orderNumber}>{task.order_number}</Text>
            {isNext && (
              <View style={styles.nextBadge}>
                <Text style={styles.nextBadgeText}>NEXT ↑</Text>
              </View>
            )}
          </View>
          <View style={styles.taskRight}>
            <Text style={styles.distance}>
              <Icon name="map-marker-distance" size={12} color={Colors.textSecondary} />
              {' '}{formatDistanceKm(task.distance_m)} km
            </Text>
          </View>
        </View>

        <Text style={styles.address} numberOfLines={2}>{task.drop_address}</Text>

        <View style={styles.taskFooter}>
          {task.cod_amount > 0 && (
            <View style={styles.codBadge}>
              <Icon name="cash" size={11} color={Colors.amber} />
              <Text style={styles.codText}>COD ₹{task.cod_amount}</Text>
            </View>
          )}
          {task.cod_amount === 0 && (
            <View style={styles.prepaidBadge}>
              <Text style={styles.prepaidText}>Prepaid</Text>
            </View>
          )}
          <Text style={styles.weight}>{task.weight_kg} kg</Text>

          {isNext && (
            <TouchableOpacity
              style={styles.acceptButton}
              onPress={() => handleAcceptTask(task)}
            >
              <Text style={styles.acceptButtonText}>Pick up</Text>
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const renderHeader = () => (
    <View style={styles.statsRow}>
      <View style={styles.statBox}>
        <Text style={styles.statValue}>{tasks.length}</Text>
        <Text style={styles.statLabel}>Pending</Text>
      </View>
      <View style={styles.statBox}>
        <Text style={styles.statValue}>₹{rider?.earnings_today ?? 0}</Text>
        <Text style={styles.statLabel}>Today's earnings</Text>
      </View>
      <View style={styles.statBox}>
        <Text style={styles.statValue}>{rider?.deliveries_today ?? 0}</Text>
        <Text style={styles.statLabel}>Delivered</Text>
      </View>
      {offlineQueue.length > 0 && (
        <View style={styles.offlineBanner}>
          <Icon name="cloud-sync" size={14} color={Colors.amber} />
          <Text style={styles.offlineText}>{offlineQueue.length} pending sync</Text>
        </View>
      )}
    </View>
  );

  const renderEmpty = () => (
    <View style={styles.emptyState}>
      <Icon name="check-circle-outline" size={48} color={Colors.green} />
      <Text style={styles.emptyTitle}>All clear!</Text>
      <Text style={styles.emptySubtitle}>No pending tasks. New orders will appear here.</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.greeting}>Hi, {rider?.name?.split(' ')[0]} 👋</Text>
          <Text style={styles.zone}>Zone {rider?.zone_name}</Text>
        </View>
        <TouchableOpacity
          style={styles.statusToggle}
          onPress={() => navigation.navigate('GoOnline')}
        >
          <View style={[styles.dot, { backgroundColor: rider?.status === 'available' ? Colors.green : Colors.red }]} />
          <Text style={styles.statusText}>
            {rider?.status === 'available' ? 'Online' : 'Offline'}
          </Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={tasks}
        keyExtractor={(t) => t.id}
        renderItem={renderTask}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={renderEmpty}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={tasks.length === 0 ? styles.emptyContainer : styles.list}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  topBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#fff', padding: 16,
    borderBottomWidth: 0.5, borderBottomColor: '#E0E0E0',
  },
  greeting: { fontSize: 17, fontWeight: '600', color: '#1A1A1A' },
  zone: { fontSize: 12, color: '#888', marginTop: 2 },
  statusToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#F5F5F5', paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 20, borderWidth: 0.5, borderColor: '#E0E0E0',
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, fontWeight: '500', color: '#333' },
  statsRow: {
    flexDirection: 'row', backgroundColor: '#fff', margin: 12,
    borderRadius: 12, padding: 14, gap: 4,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 2,
  },
  statBox: { flex: 1, alignItems: 'center' },
  statValue: { fontSize: 18, fontWeight: '600', color: '#1A1A1A' },
  statLabel: { fontSize: 10, color: '#888', marginTop: 2 },
  offlineBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#FFF8E6', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8,
  },
  offlineText: { fontSize: 10, color: '#B8860B' },
  list: { paddingHorizontal: 12, paddingBottom: 20 },
  taskCard: {
    backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 10,
    borderLeftWidth: 3,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 2,
  },
  taskHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  taskLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  orderNumber: { fontSize: 14, fontWeight: '600', color: '#1A1A1A' },
  nextBadge: {
    backgroundColor: '#E6F0FF', paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 4,
  },
  nextBadgeText: { fontSize: 9, fontWeight: '700', color: '#185FA5' },
  taskRight: {},
  distance: { fontSize: 11, color: '#888' },
  address: { fontSize: 12, color: '#555', lineHeight: 18, marginBottom: 8 },
  taskFooter: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  codBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#FFF8E6', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8,
  },
  codText: { fontSize: 11, fontWeight: '500', color: '#B8860B' },
  prepaidBadge: {
    backgroundColor: '#E8F5E9', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8,
  },
  prepaidText: { fontSize: 11, fontWeight: '500', color: '#2E7D32' },
  weight: { fontSize: 11, color: '#888', marginLeft: 'auto' },
  acceptButton: {
    backgroundColor: '#185FA5', paddingHorizontal: 14, paddingVertical: 5,
    borderRadius: 8, marginLeft: 'auto',
  },
  acceptButtonText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  emptyContainer: { flex: 1 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#1A1A1A', marginTop: 12 },
  emptySubtitle: { fontSize: 13, color: '#888', textAlign: 'center', marginTop: 6, paddingHorizontal: 40 },
});

// ─── Types ────────────────────────────────────────────────────────────
// apps/rider-app/src/types/index.ts
export interface Task {
  id: string;
  order_number: string;
  client_name: string;
  drop_address: string;
  drop_lat: number;
  drop_lng: number;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  customer_name: string;
  customer_phone_masked: string;
  customer_otp: string;
  cod_amount: number;
  weight_kg: number;
  status: string;
  sla_deadline: string;
  distance_m: number;
  eta_seconds: number;
  special_instructions?: string;
}

export interface Rider {
  id: string;
  name: string;
  phone: string;
  zone_name: string;
  status: string;
  rating: number;
  earnings_today: number;
  deliveries_today: number;
  pending_tasks: number;
}
