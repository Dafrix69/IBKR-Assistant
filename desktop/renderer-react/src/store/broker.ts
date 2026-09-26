/** 券商连接 / 断开与熔断:顶栏按钮和接入页的「连接 / 断开交易引擎」走同一条路。 */
import { dafri, errorMessage } from '../bridge';
import { showBanner } from './banner';
import { pushNotification } from './notify';
import { gatewayName, getStatus, refreshStatus } from './status';

export async function toggleBrokerConnection(): Promise<void> {
  const status = getStatus();
  const gateway = gatewayName(status);
  try {
    if (status?.broker_connected) {
      await dafri.disconnectBroker();
      pushNotification(`已断开 ${gateway} 连接`);
    } else {
      const result = await dafri.connectBroker();
      const failed = Object.entries(result.failed || {});
      // 连上了至少一条:没连上的那几条(常见的是模拟盘 TWS 没开)引擎在后台每 30 秒自动重试,不弹红条,
      // 只在通知里带一句。一条都没连上才是真出了问题,那时照旧弹红条说清原因
      if (result.connected.length) {
        const pending = failed.length ? `;${failed.map(([k]) => k).join('、')} 未连上,后台自动重试` : '';
        pushNotification('已连接', `${result.connected.join('、')}${pending}`);
      } else if (failed.length) {
        showBanner(`连接失败:${failed.map(([k, v]) => `${k}(${v})`).join(';')}`, false);
      }
    }
  } catch (err) {
    showBanner(`连接失败:${errorMessage(err)}`, false);
  } finally {
    await refreshStatus();
  }
}

export async function toggleBreaker(): Promise<void> {
  const engaged = Boolean(getStatus()?.breaker.engaged);
  try {
    if (engaged) {
      await dafri.resume();
      pushNotification('已解除熔断');
    } else {
      const result = await dafri.halt('用户在界面上按下暂停');
      pushNotification('已熔断', `撤销未成交单 ${result.cancelled ?? 0} 笔`);
    }
  } catch (err) {
    showBanner(`操作失败:${errorMessage(err)}`, false);
  } finally {
    await refreshStatus();
  }
}
