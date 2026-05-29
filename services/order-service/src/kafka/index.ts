import { Kafka, Producer, logLevel } from 'kafkajs';
import dotenv from 'dotenv';
dotenv.config({ path: '../../../.env' });

const kafka = new Kafka({
  clientId: 'order-service',
  brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  logLevel: logLevel.WARN,
});

let producer: Producer;

export async function getProducer(): Promise<Producer> {
  if (!producer) {
    producer = kafka.producer({ allowAutoTopicCreation: true });
    await producer.connect();
  }
  return producer;
}

export const kafkaClient = { publish: async (topic: string, value: object, key?: string) => {
  const p = await getProducer();
  await p.send({ topic, messages: [{ key: key || null, value: JSON.stringify(value) }] });
}};

export { kafka };
