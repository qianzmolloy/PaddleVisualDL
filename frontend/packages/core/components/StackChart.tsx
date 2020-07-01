import * as chart from '~/utils/chart';

import {EChartOption, ECharts, EChartsConvertFinder} from 'echarts';
import React, {useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState} from 'react';
import {WithStyled, primaryColor} from '~/utils/style';
import useECharts, {Options, Wrapper} from '~/hooks/useECharts';

import GridLoader from 'react-spinners/GridLoader';
import defaultsDeep from 'lodash/defaultsDeep';
import styled from 'styled-components';
import useThrottleFn from '~/hooks/useThrottleFn';

const Tooltip = styled.div`
    position: absolute;
    z-index: 1;
    background-color: rgba(0, 0, 0, 0.75);
    color: #fff;
    border-radius: 4px;
    padding: 5px;
    display: none;
`;

type renderItem = NonNullable<EChartOption.SeriesCustom['renderItem']>;
type renderItemArguments = NonNullable<renderItem['arguments']>;
type RenderItem = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any,
    api: Required<NonNullable<renderItemArguments['api']>>
) => NonNullable<renderItem['return']>;
type GetValue = (i: number) => number;
type GetCoord = (p: [number, number]) => [number, number];

export type StackChartProps = {
    options?: EChartOption;
    title?: string;
    data?: Partial<Omit<NonNullable<EChartOption<EChartOption.SeriesCustom>['series']>[number], 'data'>> & {
        minZ: number;
        maxZ: number;
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
        data: number[][];
    };
    loading?: boolean;
    zoom?: boolean;
    onInit?: Options['onInit'];
};

export type StackChartRef = {
    saveAsImage(): void;
};

const StackChart = React.forwardRef<StackChartRef, StackChartProps & WithStyled>(
    ({options, data, title, loading, zoom, className, onInit}, ref) => {
        const {minZ, maxZ, minY, maxY, minX, maxX, ...seriesData} = data ?? {
            minZ: 0,
            maxZ: 0,
            minY: 0,
            maxY: 0,
            minX: 0,
            maxX: 0,
            data: null
        };
        const rawData = seriesData.data ?? [];

        const negativeY = useMemo(() => minY - (maxY - minY) * 0.4, [minY, maxY]);

        const getPoint = useCallback(
            (x: number, y: number, z: number, getCoord: GetCoord) => {
                const pt = getCoord([x, y]);
                // bug of echarts
                if (!pt) {
                    return [0, 0];
                }
                // linear map in z axis
                pt[1] -= ((z - minZ) / (maxZ - minZ)) * (getCoord([0, minY])[1] - getCoord([0, negativeY])[1]);
                return pt;
            },
            [minZ, maxZ, minY, negativeY]
        );

        const makePolyPoints = useCallback(
            (dataIndex: number, getValue: GetValue, getCoord: GetCoord) => {
                const points = [];
                let i = 0;
                while (rawData[dataIndex] && i < rawData[dataIndex].length) {
                    const x = getValue(i++);
                    const y = getValue(i++);
                    const z = getValue(i++);
                    if (z !== 1 && i === 3) {
                        points.push(getPoint(x, y, 1, getCoord));
                    }
                    points.push(getPoint(x, y, z, getCoord));
                    if (z !== 1 && i === rawData[dataIndex].length) {
                        points.push(getPoint(x, y, 1, getCoord));
                    }
                }
                return points;
            },
            [getPoint, rawData]
        );

        const renderItem = useCallback<RenderItem>(
            (params, api) => {
                const points = makePolyPoints(params.dataIndex as number, api.value as GetValue, api.coord as GetCoord);
                return {
                    type: 'polygon',
                    silent: true,
                    z: api.value(1),
                    shape: {
                        points
                    },
                    style: api.style({
                        stroke: chart.xAxis.axisLine.lineStyle.color,
                        lineWidth: 1
                    })
                };
            },
            [makePolyPoints]
        );

        const chartOptions = useMemo<EChartOption>(() => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const {color, colorAlt, toolbox, series, ...defaults} = chart;

            return defaultsDeep(
                {
                    title: {
                        text: title ?? ''
                    },
                    visualMap: {
                        min: minY,
                        max: maxY
                    },
                    xAxis: {
                        min: minX,
                        max: maxX
                    },
                    yAxis: {
                        inverse: true,
                        position: 'right',
                        min: negativeY,
                        max: maxY,
                        axisLine: {
                            onZero: false
                        },
                        axisLabel: {
                            formatter: (value: number) => (value < minY ? '' : value + '')
                        }
                    },
                    grid: {
                        left: defaults.grid.right,
                        right: defaults.grid.left
                    },
                    tooltip: {
                        trigger: 'none',
                        showContent: false,
                        axisPointer: {
                            axis: 'y',
                            snap: false
                        }
                    },
                    series: [
                        {
                            ...series,
                            type: 'custom',
                            silent: true,
                            data: rawData,
                            renderItem
                        }
                    ]
                },
                options,
                defaults
            );
        }, [options, title, rawData, minX, maxX, minY, maxY, negativeY, renderItem]);

        const [highlight, setHighlight] = useState<number | null>(null);
        const [dots, setDots] = useState<[number, number, number][]>([]);
        const tooltipRef = useRef<HTMLDivElement | null>(null);
        const [tooltip, setTooltip] = useState('');

        const mouseout = useCallback(() => {
            setHighlight(null);
            setDots([]);
            if (chartOptions.tooltip?.formatter) {
                setTooltip('');
                if (tooltipRef.current) {
                    tooltipRef.current.style.display = 'none';
                }
            }
        }, [chartOptions.tooltip]);

        const mousemove = useCallback(
            (echarts: ECharts, e: {offsetX: number; offsetY: number}) => {
                try {
                    if (!echarts || !e) {
                        return;
                    }

                    const {offsetX, offsetY} = e;
                    if (offsetY < negativeY + ((chartOptions.grid as EChartOption.Grid).top as number) ?? 0) {
                        mouseout();
                        return;
                    }
                    const [x, y] = echarts.convertFromPixel('grid' as EChartsConvertFinder, [offsetX, offsetY]) as [
                        number,
                        number
                    ];
                    const data = (echarts.getOption().series?.[0].data as number[][]) ?? [];

                    // find right on top step
                    const steps = data.map(row => row[1]).sort((a, b) => a - b);
                    let i = 0;
                    let step: number | null = null;
                    while (i < steps.length) {
                        if (y <= steps[i++]) {
                            step = steps[i - 1];
                            break;
                        }
                    }
                    setHighlight(step == null ? null : data.findIndex(row => row[1] === step));

                    // find nearest x axis point
                    let dots: [number, number, number][] = [];
                    if (step == null) {
                        setDots(dots);
                    } else {
                        dots = data.map(row => {
                            const pt: [number, number, number] = [row[0], row[1], row[2]];
                            let d = Number.POSITIVE_INFINITY;
                            for (let j = 0; j < row.length; j += 3) {
                                const d1 = Math.abs(row[j] - x);
                                if (d1 < d) {
                                    d = d1;
                                    pt[0] = row[j];
                                    pt[2] = row[j + 2];
                                }
                            }
                            return pt;
                        });
                        setDots(dots);
                    }

                    // set tooltip
                    if (chartOptions.tooltip?.formatter) {
                        setTooltip(
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            step == null ? '' : (chartOptions.tooltip?.formatter as any)?.(step, dots)
                        );
                        if (tooltipRef.current) {
                            if (step == null) {
                                tooltipRef.current.style.display = 'none';
                            } else {
                                tooltipRef.current.style.left = `${offsetX + 10}px`;
                                tooltipRef.current.style.top = `${offsetY + 10}px`;
                                tooltipRef.current.style.display = 'block';
                            }
                        }
                    }
                } catch {
                    mouseout();
                }
            },
            [mouseout, negativeY, chartOptions.grid, chartOptions.tooltip]
        );

        const throttled = useThrottleFn(mousemove, {wait: 200});

        const init = useCallback<NonNullable<Options['onInit']>>(
            echarts => {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const zr = (echarts as any).getZr();
                    if (zr) {
                        zr.on('mousemove', (e: {offsetX: number; offsetY: number}) => throttled.run(echarts, e));

                        zr.on('mouseout', () => {
                            throttled.cancel();
                            mouseout();
                        });
                    }
                } catch {
                    throttled.cancel();
                }
                onInit?.(echarts);
            },
            [onInit, throttled, mouseout]
        );

        const {ref: echartRef, echart, wrapper, saveAsImage} = useECharts<HTMLDivElement>({
            loading: !!loading,
            zoom,
            autoFit: true,
            onInit: init
        });

        useImperativeHandle(ref, () => ({
            saveAsImage: () => {
                saveAsImage(title);
            }
        }));

        useEffect(() => {
            if (process.browser) {
                echart?.setOption(chartOptions, {notMerge: true});
            }
        }, [echart, chartOptions]);

        useEffect(() => {
            if (echart) {
                try {
                    if (highlight == null) {
                        echart.setOption({
                            graphic: {
                                elements: [
                                    {
                                        id: 'highlight',
                                        type: 'polyline',
                                        $action: 'remove'
                                    }
                                ]
                            }
                        });
                    } else {
                        const data = (echart.getOption().series?.[0].data as number[][]) ?? [];
                        const getCoord: GetCoord = pt =>
                            echart.convertToPixel('grid' as EChartsConvertFinder, pt) as [number, number];
                        const getValue: GetValue = i => data[highlight][i];
                        echart.setOption({
                            graphic: {
                                elements: [
                                    {
                                        id: 'highlight',
                                        type: 'polyline',
                                        $action: 'replace',
                                        silent: true,
                                        cursor: 'default',
                                        zlevel: 1,
                                        z: 1,
                                        shape: {
                                            points: makePolyPoints(highlight, getValue, getCoord)
                                        }
                                    }
                                ]
                            }
                        });
                    }
                } catch {
                    // ignore
                }
            }
        }, [highlight, echart, makePolyPoints]);

        useEffect(() => {
            if (echart) {
                try {
                    if (!dots.length) {
                        echart.setOption({
                            graphic: {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                elements: ((echart.getOption()?.graphic as any[])?.[0]?.elements as any[])
                                    ?.filter(element => (element.id as string).startsWith('dot'))
                                    .map(element => ({
                                        id: element.id,
                                        type: 'circle',
                                        $action: 'remove'
                                    }))
                            }
                        });
                    } else {
                        const getCoord: GetCoord = pt =>
                            echart.convertToPixel('grid' as EChartsConvertFinder, pt) as [number, number];
                        echart.setOption({
                            graphic: {
                                elements: dots.map((dot, i) => {
                                    const pt = getPoint(dot[0], dot[1], dot[2], getCoord);
                                    return {
                                        type: 'circle',
                                        id: `dot${i}`,
                                        $action: 'replace',
                                        cursor: 'default',
                                        zlevel: 1,
                                        z: 2,
                                        shape: {
                                            cx: pt[0],
                                            cy: pt[1],
                                            r: 3
                                        },
                                        style: {
                                            fill: '#fff',
                                            stroke: chartOptions.color?.[0],
                                            lineWidth: 2
                                        }
                                    };
                                })
                            }
                        });
                    }
                } catch {
                    // ignore
                }
            }
        }, [dots, echart, chartOptions.color, getPoint]);

        return (
            <Wrapper ref={wrapper} className={className}>
                {!echart && (
                    <div className="loading">
                        <GridLoader color={primaryColor} size="10px" />
                    </div>
                )}
                <div className="echarts" ref={echartRef}></div>
                <Tooltip className="tooltip" ref={tooltipRef} dangerouslySetInnerHTML={{__html: tooltip}} />
            </Wrapper>
        );
    }
);

export default StackChart;