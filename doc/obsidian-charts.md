## Ideal Graph with 集中度と疲弊度

```chart
type: line
labels: [0時, 1時, 2時, 3時, 4時, 5時, 6時, 7時, 8時, 9時, 10時, 11時, 12時, 13時, 14時, 15時, 16時, 17時, 18時, 19時, 20時, 21時, 22時, 23時]
series:
  - title: 集中度
    data: [　,　,　,　,　,　5,　5,　5,　5,　3,　4,　2,　5,　2,　5,　3,　4,　1,　3,　,　,　,　,　,　,　,]
  - title: 疲弊度
    data: [　,　,　,　,　,　,　1,　,　2,　,　5,　,　,　1,　3,　2,　5,　4,　,　,　,　,　,　,　,　,]
tension: 0
width: 40%
labelColors: false
fill: false
beginAtZero: false
bestFit: false
bestFitTitle: undefined
bestFitNumber: 0
```



## Official Documentation: 


When this Plugin is enabled, you can render a Chart using the following:

window.renderChart(data, element);
There are some full Examples:

Get data from current page 
test:: First Test
mark:: 6

```dataviewjs
const data = dv.current()

const chartData = {
    type: 'bar',
    data: {
        labels: [data.test],
        datasets: [{
            label: 'Grades',
            data: [data.mark],
            backgroundColor: [
                'rgba(255, 99, 132, 0.2)'
            ],
            borderColor: [
                'rgba(255, 99, 132, 1)'
            ],
            borderWidth: 1
        }]
    }
}

window.renderChart(chartData, this.container);
```
or you can use with charts Codeblock

test:: First Test
mark:: 6

```dataviewjs
const data = dv.current()

dv.paragraph(`\`\`\`chart
    type: bar
    labels: [${data.test}]
    series:
    - title: Grades
      data: [${data.mark}]
\`\`\``)
```
Get data from multi-pages 
```dataviewjs
const pages = dv.pages('#test')
const testNames = pages.map(p => p.file.name).values
const testMarks = pages.map(p => p.mark).values

const chartData = {
    type: 'bar',
    data: {
        labels: testNames,
        datasets: [{
            label: 'Mark',
            data: testMarks,
            backgroundColor: [
                'rgba(255, 99, 132, 0.2)'
            ],
            borderColor: [
                'rgba(255, 99, 132, 1)'
            ],
            borderWidth: 1,
        }]
    }
}

window.renderChart(chartData, this.container)
```
The data is the standard Chart.js data payload, you can use everything it supports in there.