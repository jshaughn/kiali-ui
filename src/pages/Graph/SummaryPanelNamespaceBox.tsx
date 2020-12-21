import * as React from 'react';
import { Tab } from '@patternfly/react-core';
import { style } from 'typestyle';
import _ from 'lodash';
import { RateTableGrpc, RateTableHttp } from '../../components/SummaryPanel/RateTable';
import { RpsChart, TcpChart } from '../../components/SummaryPanel/RpsChart';
import { SummaryPanelPropType, NodeType } from '../../types/Graph';
import { getAccumulatedTrafficRateGrpc, getAccumulatedTrafficRateHttp } from '../../utils/TrafficRate';
import * as API from '../../services/Api';
import {
  shouldRefreshData,
  getFirstDatapoints,
  mergeMetricsResponses,
  summaryFont,
  summaryHeader,
  summaryBodyTabs,
  hr
} from './SummaryPanelCommon';
import { Response } from '../../services/Api';
import { IstioMetricsMap, Datapoint } from '../../types/Metrics';
import { IstioMetricsOptions } from '../../types/MetricsOptions';
import { CancelablePromise, makeCancelablePromise, PromisesRegistry } from '../../utils/CancelablePromises';
import { CyNode } from '../../components/CytoscapeGraph/CytoscapeGraphUtils';
import { KialiIcon } from 'config/KialiIcon';
import SimpleTabs from 'components/Tab/SimpleTabs';
import { ValidationStatus } from 'types/IstioObjects';
import Namespace from 'types/Namespace';
import { PfColors } from '../../components/Pf/PfColors';

type SummaryPanelNamespaceBoxMetricsState = {
  reqRates: Datapoint[];
  errRates: Datapoint[];
  tcpSent: Datapoint[];
  tcpReceived: Datapoint[];
  metricsLoadError: string | null;
};

type ValidationsMap = Map<string, ValidationStatus>;

type SummaryPanelNamespaceBoxState = SummaryPanelNamespaceBoxMetricsState & {
  isOpen: boolean;
  namespaceBox: any;
  loading: boolean;
  validationsLoading: boolean;
  validationsMap: ValidationsMap;
};

const defaultMetricsState: SummaryPanelNamespaceBoxMetricsState = {
  reqRates: [],
  errRates: [],
  tcpSent: [],
  tcpReceived: [],
  metricsLoadError: null
};

const defaultState: SummaryPanelNamespaceBoxState = {
  isOpen: false,
  namespaceBox: null,
  loading: false,
  validationsLoading: false,
  validationsMap: new Map<string, ValidationStatus>(),
  ...defaultMetricsState
};

const topologyStyle = style({
  margin: '0 1em'
});

export default class SummaryPanelNamespaceBox extends React.Component<
  SummaryPanelPropType,
  SummaryPanelNamespaceBoxState
> {
  static readonly panelStyle = {
    height: '100%',
    margin: 0,
    minWidth: '25em',
    overflowY: 'auto' as 'auto',
    backgroundColor: PfColors.White,
    width: '25em'
  };

  private metricsPromise?: CancelablePromise<Response<IstioMetricsMap>>;
  private validationSummaryPromises: PromisesRegistry = new PromisesRegistry();

  constructor(props: SummaryPanelPropType) {
    super(props);

    this.state = { ...defaultState };
  }

  static getDerivedStateFromProps(props: SummaryPanelPropType, state: SummaryPanelNamespaceBoxState) {
    // if the summaryTarget (i.e. namespaceBox) has changed, then init the state and set to loading. The loading
    // will actually be kicked off after the render (in componentDidMount/Update).
    return props.data.summaryTarget !== state.namespaceBox
      ? { graph: props.data.summaryTarget, loading: true, ...defaultMetricsState }
      : null;
  }

  componentDidMount() {
    this.updateRpsChart();
    this.updateValidations();
  }

  componentDidUpdate(prevProps: SummaryPanelPropType) {
    if (shouldRefreshData(prevProps, this.props)) {
      this.updateRpsChart();
      this.updateValidations();
    }
  }

  componentWillUnmount() {
    if (this.metricsPromise) {
      this.metricsPromise.cancel();
    }
  }

  render() {
    const namespaceBox = this.props.data.summaryTarget;
    const boxed = namespaceBox.descendants();

    const numSvc = boxed.filter(`node[nodeType = "${NodeType.SERVICE}"]`).size();
    const numWorkloads = boxed.filter(`node[nodeType = "${NodeType.WORKLOAD}"]`).size();
    const { numApps, numVersions } = this.countApps(boxed);
    const numEdges = boxed.edges().size();
    // when getting accumulated traffic rates don't count requests from injected service nodes
    const nonServiceEdges = boxed.filter(`node[nodeType != "${NodeType.SERVICE}"][!isBox]`).edgesTo('*');
    const totalRateGrpc = getAccumulatedTrafficRateGrpc(nonServiceEdges);
    const totalRateHttp = getAccumulatedTrafficRateHttp(nonServiceEdges);
    const incomingEdges = boxed.filter(`node[?${CyNode.isRoot}]`).edgesTo('*');
    const incomingRateGrpc = getAccumulatedTrafficRateGrpc(incomingEdges);
    const incomingRateHttp = getAccumulatedTrafficRateHttp(incomingEdges);
    const outgoingEdges = boxed
      .filter()
      .leaves(`node[?${CyNode.isOutside}],[?${CyNode.isServiceEntry}]`)
      .connectedEdges();
    const outgoingRateGrpc = getAccumulatedTrafficRateGrpc(outgoingEdges);
    const outgoingRateHttp = getAccumulatedTrafficRateHttp(outgoingEdges);

    return (
      <div className="panel panel-default" style={SummaryPanelNamespaceBox.panelStyle}>
        <div className="panel-heading" style={summaryHeader}>
          {this.renderTopologySummary(numSvc, numWorkloads, numApps, numVersions, numEdges)}
        </div>
        <div className={summaryBodyTabs}>
          <SimpleTabs id="graph_summary_tabs" defaultTab={0} style={{ paddingBottom: '10px' }}>
            <Tab style={summaryFont} title="Incoming" eventKey={0}>
              <div style={summaryFont}>
                {incomingRateGrpc.rate === 0 && incomingRateHttp.rate === 0 && (
                  <>
                    <KialiIcon.Info /> No incoming traffic.
                  </>
                )}
                {incomingRateGrpc.rate > 0 && (
                  <RateTableGrpc
                    title="GRPC Traffic (requests per second):"
                    rate={incomingRateGrpc.rate}
                    rateGrpcErr={incomingRateGrpc.rateGrpcErr}
                    rateNR={incomingRateGrpc.rateNoResponse}
                  />
                )}
                {incomingRateHttp.rate > 0 && (
                  <RateTableHttp
                    title="HTTP (requests per second):"
                    rate={incomingRateHttp.rate}
                    rate3xx={incomingRateHttp.rate3xx}
                    rate4xx={incomingRateHttp.rate4xx}
                    rate5xx={incomingRateHttp.rate5xx}
                    rateNR={incomingRateHttp.rateNoResponse}
                  />
                )}
                {
                  // We don't show a sparkline here because we need to aggregate the traffic of an
                  // ad hoc set of [root] nodes. We don't have backend support for that aggregation.
                }
              </div>
            </Tab>
            <Tab style={summaryFont} title="Outgoing" eventKey={1}>
              <div style={summaryFont}>
                {outgoingRateGrpc.rate === 0 && outgoingRateHttp.rate === 0 && (
                  <>
                    <KialiIcon.Info /> No outgoing traffic.
                  </>
                )}
                {outgoingRateGrpc.rate > 0 && (
                  <RateTableGrpc
                    title="GRPC Traffic (requests per second):"
                    rate={outgoingRateGrpc.rate}
                    rateGrpcErr={outgoingRateGrpc.rateGrpcErr}
                    rateNR={outgoingRateGrpc.rateNoResponse}
                  />
                )}
                {outgoingRateHttp.rate > 0 && (
                  <RateTableHttp
                    title="HTTP (requests per second):"
                    rate={outgoingRateHttp.rate}
                    rate3xx={outgoingRateHttp.rate3xx}
                    rate4xx={outgoingRateHttp.rate4xx}
                    rate5xx={outgoingRateHttp.rate5xx}
                    rateNR={outgoingRateHttp.rateNoResponse}
                  />
                )}
                {
                  // We don't show a sparkline here because we need to aggregate the traffic of an
                  // ad hoc set of [root] nodes. We don't have backend support for that aggregation.
                }
              </div>
            </Tab>
            <Tab style={summaryFont} title="Total" eventKey={2}>
              <div style={summaryFont}>
                {totalRateGrpc.rate === 0 && totalRateHttp.rate === 0 && (
                  <>
                    <KialiIcon.Info /> No traffic.
                  </>
                )}
                {totalRateGrpc.rate > 0 && (
                  <RateTableGrpc
                    title="GRPC Traffic (requests per second):"
                    rate={totalRateGrpc.rate}
                    rateGrpcErr={totalRateGrpc.rateGrpcErr}
                    rateNR={totalRateGrpc.rateNoResponse}
                  />
                )}
                {totalRateHttp.rate > 0 && (
                  <RateTableHttp
                    title="HTTP (requests per second):"
                    rate={totalRateHttp.rate}
                    rate3xx={totalRateHttp.rate3xx}
                    rate4xx={totalRateHttp.rate4xx}
                    rate5xx={totalRateHttp.rate5xx}
                    rateNR={totalRateHttp.rateNoResponse}
                  />
                )}
                <div>
                  {hr()}
                  {this.renderRpsChart()}
                </div>
              </div>
            </Tab>
          </SimpleTabs>
        </div>
      </div>
    );
  }

  private countApps = (boxed): { numApps: number; numVersions: number } => {
    const appVersions: { [key: string]: Set<string> } = {};

    boxed.filter(`node[nodeType = "${NodeType.APP}"]`).forEach(node => {
      const app = node.data(CyNode.app);
      if (appVersions[app] === undefined) {
        appVersions[app] = new Set();
      }
      appVersions[app].add(node.data(CyNode.version));
    });

    return {
      numApps: Object.getOwnPropertyNames(appVersions).length,
      numVersions: Object.getOwnPropertyNames(appVersions).reduce((totalCount: number, version: string) => {
        return totalCount + appVersions[version].size;
      }, 0)
    };
  };

  private renderTopologySummary = (
    numSvc: number,
    numWorkloads: number,
    numApps: number,
    numVersions: number,
    numEdges: number
  ) => (
    <>
      <br />
      <strong>Current Graph:</strong>
      <br />
      {numApps > 0 && (
        <>
          <KialiIcon.Applications className={topologyStyle} />
          {numApps.toString()} {numApps === 1 ? 'app ' : 'apps '}
          {numVersions > 0 && `(${numVersions} versions)`}
          <br />
        </>
      )}
      {numSvc > 0 && (
        <>
          <KialiIcon.Services className={topologyStyle} />
          {numSvc.toString()} {numSvc === 1 ? 'service' : 'services'}
          <br />
        </>
      )}
      {numWorkloads > 0 && (
        <>
          <KialiIcon.Workloads className={topologyStyle} />
          {numWorkloads.toString()} {numWorkloads === 1 ? 'workload' : 'workloads'}
          <br />
        </>
      )}
      {numEdges > 0 && (
        <>
          <KialiIcon.Topology className={topologyStyle} />
          {numEdges.toString()} {numEdges === 1 ? 'edge' : 'edges'}
        </>
      )}
    </>
  );

  private renderRpsChart = () => {
    if (this.state.loading) {
      return <strong>Loading chart...</strong>;
    } else if (this.state.metricsLoadError) {
      return (
        <div>
          <KialiIcon.Warning /> <strong>Error loading metrics: </strong>
          {this.state.metricsLoadError}
        </div>
      );
    }

    return (
      <>
        <RpsChart label="HTTP - Total Request Traffic" dataRps={this.state.reqRates} dataErrors={this.state.errRates} />
        <TcpChart label="TCP - Total Traffic" receivedRates={this.state.tcpReceived} sentRates={this.state.tcpSent} />
      </>
    );
  };

  private updateRpsChart = () => {
    const props: SummaryPanelPropType = this.props;
    const namespace = props.data.summaryTarget.data(CyNode.namespace);
    const options: IstioMetricsOptions = {
      filters: ['request_count', 'request_error_count'],
      queryTime: props.queryTime,
      duration: props.duration,
      step: props.step,
      rateInterval: props.rateInterval,
      direction: 'inbound',
      reporter: 'destination'
    };
    const promiseHTTP = API.getNamespaceMetrics(namespace, options);
    // TCP metrics are only available for reporter="source"
    const optionsTCP: IstioMetricsOptions = {
      filters: ['tcp_sent', 'tcp_received'],
      queryTime: props.queryTime,
      duration: props.duration,
      step: props.step,
      rateInterval: props.rateInterval,
      direction: 'inbound',
      reporter: 'source'
    };
    const promiseTCP = API.getNamespaceMetrics(namespace, optionsTCP);
    this.metricsPromise = makeCancelablePromise(mergeMetricsResponses([promiseHTTP, promiseTCP]));

    this.metricsPromise.promise
      .then(response => {
        this.setState({
          loading: false,
          reqRates: getFirstDatapoints(response.data.request_count),
          errRates: getFirstDatapoints(response.data.request_error_count),
          tcpSent: getFirstDatapoints(response.data.tcp_sent),
          tcpReceived: getFirstDatapoints(response.data.tcp_received)
        });
      })
      .catch(error => {
        if (error.isCanceled) {
          console.debug('SummaryPanelGraph: Ignore fetch error (canceled).');
          return;
        }
        const errorMsg = error.response && error.response.data.error ? error.response.data.error : error.message;
        this.setState({
          loading: false,
          metricsLoadError: errorMsg,
          ...defaultMetricsState
        });
      });

    this.setState({ loading: true, metricsLoadError: null });
  };

  private updateValidations = () => {
    const newValidationsMap = new Map<string, ValidationStatus>();
    _.chunk([this.props.data.summaryTarget.data(CyNode.namespace)], 10).forEach(chunk => {
      this.validationSummaryPromises
        .registerChained('validationSummaryChunks', undefined, () =>
          this.fetchValidationsChunk(chunk, newValidationsMap)
        )
        .then(() => {
          this.setState({ validationsMap: newValidationsMap });
        });
    });
  };

  fetchValidationsChunk(chunk: Namespace[], validationsMap: ValidationsMap) {
    return Promise.all(
      chunk.map(ns => {
        return API.getNamespaceValidations(ns.name).then(rs => ({ validation: rs.data, ns: ns }));
      })
    )
      .then(results => {
        results.forEach(result => {
          validationsMap[result.ns.name] = result.validation;
        });
      })
      .catch(err => {
        if (!err.isCanceled) {
          console.log(`SummaryPanelGraph: Error fetching validation status: ${API.getErrorString(err)}`);
        }
      });
  }
}
